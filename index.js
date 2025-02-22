const core = require('@actions/core');
const YAML = require('yaml');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchGitLab = async (url, token) => {
    return await fetch(url, {
        method: 'GET',
        headers: {
            'PRIVATE-TOKEN': token,
            'Accept': 'application/json',
        },
    });
}

const checkOkay = (response) => {
    if (!response.ok) {
        let errorMessage = `GitLab API returned status code ${response.status}.`;
        if (response.status === 401) {
            errorMessage = "Unauthorized: invalid/expired access token was used.";
        }
        core.setFailed(errorMessage);
        return false;
    }
    return true;
}

/**
 * GitLab pipeline status values (see https://docs.gitlab.com/ee/api/pipelines.html#list-project-pipelines):
 * - created: The pipeline has been created but has not yet been processed.
 * - preparing: The pipeline is being prepared to run.
 * - pending: The pipeline is queued and waiting for available resources to start running.
 * - waiting_for_resource: The pipeline is queued, but there are not enough resources available to start running.
 * - running: The pipeline is currently running.
 * - scheduled: The pipeline is scheduled to run at a later time.
 * - failed: The pipeline has completed running, but one or more jobs have failed.
 * - success: The pipeline has completed running, and all jobs have succeeded.
 * - canceled: The pipeline has been canceled by a user or system.
 * - skipped: The pipeline was skipped due to a configuration option or a pipeline rule.
 * - manual: The pipeline is waiting for a user to trigger it manually.
 */
const pollPipeline = async (host, projectId, token, githubToken, pipelineId, webUrl) => {
    console.log(`Polling pipeline ${pipelineId} on ${host}!`);

    const url = `https://${host}/api/v4/projects/${projectId}/pipelines/${pipelineId}`;
    let status = 'pending';
    const breakStatusList = ['failed', 'success', 'canceled', 'skipped'];

    let retryCount = 5; // in case of connection errors, retry again later

    while (true) {
        // wait 15 seconds
        await wait(15000);

        try {
            const response = await fetchGitLab(url, token);

            if (!checkOkay(response)) {
                break;
            }

            const data = await response.json();

            status = data.status;
            core.setOutput("status", status);
            console.log(`Pipeline status: ${status} (${webUrl})`);

            if (status === 'failed') {
                const jobsResponse = await fetchGitLab(`https://${host}/api/v4/projects/${projectId}/pipelines/${pipelineId}/jobs?include_retried=true`, token)
                if (!checkOkay(jobsResponse)) {
                    break;
                }
                // jobs sorted by ID in descending order (newest first).
                const jobsData = await jobsResponse.json();

                // fetch the gitlab-ci file (containing job information)
                const ymlResponse = await fetch(`https://${host}/api/v4/projects/${projectId}/repository/files/.gitlab-ci.yml/raw?ref=main`, {
                    method: 'GET',
                    headers: {
                        'PRIVATE-TOKEN': token,
                    },
                });
                if (!checkOkay(ymlResponse)) {
                    break;
                }
                const gitlabYml = YAML.parse(await ymlResponse.text());

                const storedJobs = {};

                for (let job of jobsData) {
                    if (job.name in storedJobs) continue; // already
                    const jobDef = gitlabYml[job.name];
                    if (job.name === 'info') continue;
                    const jobInfo = {
                        status: job.status,
                        web_url: job.web_url,
                        github: jobDef.extends.endsWith('hub'),
                        prev: "unknown"
                    };
                    storedJobs[job.name] = jobInfo;
                    if (job.name === 'monticore_basic' || job.name === 'monticore') {
                        jobInfo.git = 'monticore/monticore';
                        jobInfo.github = true;
                    } else if (jobDef.variables) {
                        jobInfo.git = jobDef.variables.JOB_GIT;
                    }

                    // Only inspect the previous status IF the change breaks it
                    if (job.status === 'success') continue;

                    const projectDefaultBranch = "dev";
                    if (jobInfo.github) {
                        const actionsResponse = await fetch(`https://api.github.com/repos/${jobInfo.git}/actions/runs?branch=${projectDefaultBranch}&per_page=5&status=completed`, {
                            method: 'GET',
                            headers: {
                                'Authorization': githubToken,
                                'Accept': 'application/vnd.github+json',
                            },
                        });
                        const actionsResponseData = await actionsResponse.json();
                        if (!actionsResponseData.workflow_runs) {
                            console.warn(`Failed to inspect previous CI of ${job.name}`)
                            console.log(actionsResponseData)
                            return status;
                        }
                        jobInfo.prev = actionsResponseData.workflow_runs[0].conclusion === 'failure' ? "fail" : "success"
                    } else {
                        const projectNameSpace = encodeURIComponent(jobInfo.git)
                        const projPipelinesResp = await fetchGitLab(`https://${host}/api/v4/projects/${projectNameSpace}/pipelines?ref=${projectDefaultBranch}`, token);
                        if (!checkOkay(projPipelinesResp)) {
                            break;
                        } else {
                            jobInfo.prev = "GitLab: No Job found";
                            for (let pipeline of await projPipelinesResp.json()) {
                                if (pipeline.status === 'failed')
                                    jobInfo.prev = 'fail';
                                else if (pipeline.status === 'success')
                                    jobInfo.prev = 'success';
                                else
                                    continue;
                                break;
                            }
                        }
                    }
                }


                let errorMessage = "";
                let errorTable = []
                let infoTable = []
                let failed = false;
                for (let jobKey in storedJobs) {
                    const job = storedJobs[jobKey];
                    console.log(`${jobKey}: ${job.prev} -> ${job.status}  (${job.web_url})`)
                    if (job.status !== 'success') {
                        if (job.prev === 'fail') {
                            console.warn("  Job might have failed " + jobKey);
                            core.warning(`Change might have broken project '${jobKey}' (CI of project failed before)`)
                            infoTable.push(`| ${jobKey} | [:warning:](${job.web_url})| `)
                            errorTable.push(`| ${jobKey} | [:warning:](${job.web_url})| `)
                        } else {
                            console.error("  Job broke " + jobKey);
                            core.error(`Change broke project '${jobKey}'`)
                            errorMessage += `Job ${jobKey} failed\n`;
                            infoTable.push(`| ${jobKey} | [:x:](${job.web_url})| `)
                            errorTable.push(`| ${jobKey} | [:x:](${job.web_url})| `)
                            failed = true;
                        }
                    } else {
                        infoTable.push(`| ${jobKey} | [:white_check_mark:](${job.web_url})| `)
                    }
                }
                const withTable = (table) => ` | Project | Status | \n |---|---| \n ${table.join('\n')}`;
                const withDetails = (summary) => `<details> <summary>${summary}</summary> 
${withTable(infoTable)} 
The MontiVerse is a collection of (internal and public) language projects.</details>`;
                if (failed) {
                    core.setOutput('pretty_output', `:x: Changes break the MontiVerse \n ${withTable(errorTable)}\n${withDetails('details')}`)
                } else if (errorTable) {
                    core.setOutput('pretty_output', `:warning: Changes might break the MontiVerse \n ${withTable(errorTable)}\n${withDetails('details')}`)
                } else {
                    core.setOutput('pretty_output', `:heavy_check_mark: Changes pass the MontiVerse \n ${withTable(errorTable)}\n${withDetails('details')}`)
                }
                if (errorMessage)
                    core.setFailed(errorMessage);


            }

            if (breakStatusList.includes(status)) {
                console.log(`Status "${status}" detected, breaking loop!`);
                break;
            }
        } catch (error) {
            console.warn("error")
            console.warn(error)
            retryCount--;
            if (retryCount <= 0) {
                core.setFailed(error.message);
                break;
            }
        }
    }

    return status;
}

async function run() {
    const host = encodeURIComponent(core.getInput('host'));
    const projectId = encodeURIComponent(core.getInput('id'));
    const triggerToken = core.getInput('trigger_token');
    const accessToken = core.getInput('access_token');
    const githubAccessToken = core.getInput('github_access_token');
    const ref = core.getInput('ref');
    const variables = JSON.parse(core.getInput('variables'));

    console.log(`Triggering pipeline ${projectId} with ref ${ref} on ${host}!`);

    try {
        const url = `https://${host}/api/v4/projects/${projectId}/trigger/pipeline`;

        // https://docs.gitlab.com/ee/api/pipeline_triggers.html#trigger-a-pipeline-with-a-token
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                token: triggerToken,
                ref: ref,
                variables: variables,
            }),
        });

        if (!response.ok) {
            let errorMessage = `GitLab API returned status code ${response.status}.`;
            if (response.status === 404) {
                errorMessage = "The specified resource does not exist, or an invalid/expired trigger token was used.";
            }
            return core.setFailed(errorMessage);
        }

        const data = await response.json();

        core.setOutput("id", data.id);
        core.setOutput("status", data.status);
        core.setOutput("web_url", data.web_url);
        console.log(`Pipeline id ${data.id} triggered! See ${data.web_url} for details.`);

        // poll pipeline status
        await pollPipeline(host, projectId, accessToken, githubAccessToken, data.id, data.web_url);
    } catch (error) {
        core.setFailed(error.message);
    }
}

run()
