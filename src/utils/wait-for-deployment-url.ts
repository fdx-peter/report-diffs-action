import { getOctokit } from "@actions/github";
import { GitHub } from "@actions/github/lib/utils";
import { Hub } from "@sentry/node";
import { Transaction } from "@sentry/types";
import { EXPECTED_PERMISSIONS_BLOCK } from "./constants";

const TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes
const MIN_POLL_FREQUENCY = 1_000;
const MAX_POLL_FREQUENCY = 10 * 1_000;

export const waitForDeploymentUrl = async ({
  owner,
  repo,
  commitSha,
  octokit,
  sentryHub,
  transaction,
  allowedEnvironments,
}: {
  owner: string;
  repo: string;
  commitSha: string;
  octokit: InstanceType<typeof GitHub>;
  sentryHub: Hub;
  transaction: Transaction;
  allowedEnvironments: string[] | null;
}): Promise<string> => {
  const waitForDeploymentSpan = transaction.startChild({
    op: "waitForDeployment",
  });
  const startTime = Date.now();
  let pollFrequency = MIN_POLL_FREQUENCY;
  let deploymentsFound: DeploymentsArray | null = null;
  while (Date.now() - startTime < TIMEOUT_MS) {
    const { deploymentUrl, availableDeployments } = await getDeploymentUrl({
      owner,
      repo,
      commitSha,
      octokit,
      sentryHub,
      allowedEnvironments,
    });
    deploymentsFound = availableDeployments;
    if (deploymentUrl != null) {
      console.log(`Testing against deployment URL '${deploymentUrl}'`);
      return deploymentUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, pollFrequency));
    pollFrequency = Math.min(
      MAX_POLL_FREQUENCY,
      pollFrequency + MIN_POLL_FREQUENCY
    );
  }
  waitForDeploymentSpan.finish();

  const timeoutInSeconds = (TIMEOUT_MS / 1000).toFixed(0);
  const environmentFilter =
    allowedEnvironments != null
      ? ` for an environment named ${joinWithOr(
          allowedEnvironments.map((e) => `'${e}'`)
        )}`
      : "";
  throw new Error(
    `Timed out after waiting ${timeoutInSeconds} seconds for a successful deployment URL for commit ${commitSha}${environmentFilter}. ` +
      `Available deployments: ${describeDeployments(deploymentsFound)}.`
  );
};

const MAX_GITHUB_ALLOWED_PAGE_SIZE = 100;

type DeploymentsArray = Awaited<
  ReturnType<ReturnType<typeof getOctokit>["rest"]["repos"]["listDeployments"]>
>["data"];

const getDeploymentUrl = async ({
  owner,
  repo,
  commitSha,
  octokit,
  sentryHub,
  allowedEnvironments,
}: {
  owner: string;
  repo: string;
  commitSha: string;
  octokit: InstanceType<typeof GitHub>;
  sentryHub: Hub;
  allowedEnvironments: string[] | null;
}): Promise<{
  deploymentUrl: string | null;
  availableDeployments: DeploymentsArray | null;
}> => {
  let deployments: Awaited<
    ReturnType<typeof octokit.rest.repos.listDeployments>
  > | null = null;
  try {
    deployments = await octokit.rest.repos.listDeployments({
      owner,
      repo,
      sha: commitSha,
      per_page: MAX_GITHUB_ALLOWED_PAGE_SIZE,
    });
  } catch (err) {
    console.error("Error listing deployments", err);
  }

  if (deployments == null || deployments.status !== 200) {
    throw new Error(
      `Failed to list deployments for commit ${commitSha}.\n\n` +
        "Note: if using 'use-deployment-url' then you must provide permissions for the action to read deployments. " +
        "To do this edit the 'permissions:' block in your workflow file to include 'deployments: read'. Your permissions block should look like:\n\n" +
        EXPECTED_PERMISSIONS_BLOCK
    );
  }

  console.debug(`Found ${deployments.data.length} deployments`);

  if (hasMorePages(deployments)) {
    throw new Error(
      `More than ${MAX_GITHUB_ALLOWED_PAGE_SIZE} deployments found for commit ${commitSha}. Meticulous currently supports at most ${MAX_GITHUB_ALLOWED_PAGE_SIZE} deployments per commit.`
    );
  }

  sentryHub.captureEvent({
    message: "Found deployments",
    level: "debug",
    extra: {
      deployments: deployments.data.map((deployment) => ({
        id: deployment.id,
        environment: deployment.environment,
        original_environment: deployment.original_environment,
        production_environment: deployment.production_environment,
      })),
      allowedEnvironments,
    },
  });

  const matchingDeployments = deployments.data.filter(
    (deployment) =>
      allowedEnvironments == null ||
      allowedEnvironments.includes(deployment.environment)
  );

  if (matchingDeployments.length > 1) {
    if (allowedEnvironments == null) {
      console.warn(
        `More than one deployment found for commit ${commitSha}: ${describeDeployments(
          matchingDeployments
        )}. Please specify an environment name using the 'allowed-environments' input.`
      );
    } else {
      throw new Error(
        `More than one deployment found for commit ${commitSha} for an environment named ${joinWithOr(
          allowedEnvironments.map((e) => `'${e}'`)
        )}.`
      );
    }
  }

  const latestMatchingDeployment = findLatest(matchingDeployments);

  if (latestMatchingDeployment == null) {
    return { deploymentUrl: null, availableDeployments: deployments.data };
  }

  console.debug(`Checking status of deployment ${latestMatchingDeployment.id}`);

  const deploymentStatuses = await octokit.rest.repos.listDeploymentStatuses({
    owner,
    repo,
    deployment_id: latestMatchingDeployment.id,
    per_page: MAX_GITHUB_ALLOWED_PAGE_SIZE,
  });

  if (hasMorePages(deploymentStatuses)) {
    throw new Error(
      `More than ${MAX_GITHUB_ALLOWED_PAGE_SIZE} deployment status found for deployment ${latestMatchingDeployment.id} of commit ${commitSha}. Meticulous currently supports at most ${MAX_GITHUB_ALLOWED_PAGE_SIZE} deployment statuses per deployment.`
    );
  }

  const deploymentStatus = deploymentStatuses.data.find(
    (status) => status.state === "success"
  );
  if (deploymentStatus?.environment_url != null) {
    return {
      deploymentUrl: deploymentStatus?.environment_url,
      availableDeployments: deployments.data,
    };
  }

  const latestDeploymentStatus = findLatest(deploymentStatuses.data);
  if (
    latestDeploymentStatus?.state === "error" ||
    latestDeploymentStatus?.state === "failure"
  ) {
    throw new Error(
      `Deployment ${latestMatchingDeployment.id} failed with status ${latestDeploymentStatus?.state}. Cannot test against a failed deployment.`
    );
  }

  return { deploymentUrl: null, availableDeployments: deployments.data }; // Let's continue waiting for a successful deployment
};

const describeDeployments = (deployments: DeploymentsArray | null): string => {
  if (deployments == null || deployments.length === 0) {
    return "none";
  }
  const deploymentDescriptions = deployments.map(
    (deployment) =>
      `deployment ${deployment.id} (environment name: "${deployment.environment}", description: "${deployment.description}")`
  );
  return deploymentDescriptions.join(", ");
};

const findLatest = <T extends { created_at: string }>(items: T[]): T | null => {
  let latest = items[0];
  items.forEach((item) => {
    if (
      Date.parse(item.created_at).valueOf() >
      Date.parse(latest.created_at).valueOf()
    ) {
      latest = item;
    }
  });
  return latest ?? null;
};

const hasMorePages = (response: { headers: { link?: string | undefined } }) =>
  response.headers.link?.includes('rel="next"');

const joinWithOr = (names: string[]): string => {
  if (names.length === 0) {
    return "";
  }
  if (names.length === 1) {
    return names[0];
  }
  if (names.length === 2) {
    return `${names[0]} or ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
};
