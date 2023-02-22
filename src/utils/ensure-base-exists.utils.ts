import { warning as ghWarning } from "@actions/core";
import { Context } from "@actions/github/lib/context";
import { GitHub } from "@actions/github/lib/utils";
import { getLatestTestRunResults } from "@alwaysmeticulous/cli";
import { createClient } from "@alwaysmeticulous/cli/dist/api/client.js";
import { METICULOUS_LOGGER_NAME } from "@alwaysmeticulous/common";
import log from "loglevel";
import { CodeChangeEvent } from "../types";
import {
  getCurrentWorkflowId,
  getOrStartNewWorkflowRun,
  waitForWorkflowCompletion,
} from "./workflow.utils";

export const safeEnsureBaseTestsExists: typeof ensureBaseTestsExists = async (
  ...params
) => {
  const logger = log.getLogger(METICULOUS_LOGGER_NAME);
  try {
    return await ensureBaseTestsExists(...params);
  } catch (error) {
    logger.error(error);
    const message = `Error while running tests on base ${params[0].base}. No diffs will be reported for this run.`;
    logger.warn(message);
    ghWarning(message);
    return { shaToCompareAgainst: null };
  }
};

export const ensureBaseTestsExists = async ({
  event,
  apiToken,
  base, // from the PR event
  context,
  octokit,
}: {
  event: CodeChangeEvent;
  apiToken: string;
  base: string | null;
  context: Context;
  octokit: InstanceType<typeof GitHub>;
}): Promise<{ shaToCompareAgainst: string | null }> => {
  const logger = log.getLogger(METICULOUS_LOGGER_NAME);

  // Running missing tests on base is only supported for Pull Request events
  if (event.type !== "pull_request" || !base) {
    return { shaToCompareAgainst: null };
  }

  const { owner, repo } = context.repo;
  const baseRef = event.payload.pull_request.base.ref;

  logger.debug(JSON.stringify({ base, baseRef }, null, 2));

  const testRun = await getLatestTestRunResults({
    client: createClient({ apiToken }),
    commitSha: base,
  });

  if (testRun != null) {
    logger.log(`Tests already exist for commit ${base} (${testRun.id})`);
    return { shaToCompareAgainst: base };
  }

  const { workflowId } = await getCurrentWorkflowId({ context, octokit });

  // We can only trigger a workflow_run against the head of the base branch
  // This will give some spurious diffs if it's different from `base`, but it's the best we can do

  const currentBaseSha = await getHeadCommitForRef({
    owner,
    repo,
    ref: baseRef,
    octokit,
  });

  logger.debug(
    JSON.stringify({ owner, repo, base, baseRef, currentBaseSha }, null, 2)
  );
  if (base !== currentBaseSha) {
    const message = `Pull request event received ${base} as the base commit but ${baseRef} \
is now pointing to ${currentBaseSha}. Will use ${currentBaseSha} for Meticulous tests. Re-running the tests will likely fix this.`;
    logger.warn(message);
    ghWarning(message);
  }

  const testRunForHeadOfBaseBranch = await getLatestTestRunResults({
    client: createClient({ apiToken }),
    commitSha: currentBaseSha,
  });

  if (testRunForHeadOfBaseBranch != null) {
    logger.log(
      `Tests already exist for commit ${currentBaseSha} (${testRunForHeadOfBaseBranch.id})`
    );
    return { shaToCompareAgainst: currentBaseSha };
  }

  const workflowRun = await getOrStartNewWorkflowRun({
    owner,
    repo,
    workflowId,
    ref: baseRef,
    commitSha: currentBaseSha,
    octokit,
  });

  if (workflowRun == null) {
    const message = `Warning: Could not retrieve dispatched workflow run. Will not perform diffs against ${currentBaseSha}.`;
    logger.warn(message);
    ghWarning(message);
    return { shaToCompareAgainst: null };
  }

  logger.log(`Waiting on workflow run: ${workflowRun.html_url}`);
  const finalWorkflowRun = await waitForWorkflowCompletion({
    owner,
    repo,
    workflowRunId: workflowRun.workflowRunId,
    octokit,
  });

  if (
    finalWorkflowRun.status !== "completed" ||
    finalWorkflowRun.conclusion !== "success"
  ) {
    throw new Error(
      `Comparing against screenshots taken on ${baseRef}, but the corresponding workflow run [${finalWorkflowRun.id}] did not complete successfully. See: ${finalWorkflowRun.html_url}`
    );
  }

  return { shaToCompareAgainst: currentBaseSha };
};

const getHeadCommitForRef = async ({
  owner,
  repo,
  ref,
  octokit,
}: {
  owner: string;
  repo: string;
  ref: string;
  octokit: InstanceType<typeof GitHub>;
}): Promise<string> => {
  const result = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch: ref,
  });
  const commitSha = result.data.commit.sha;
  return commitSha;
};
