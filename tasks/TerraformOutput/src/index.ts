import * as path from 'path';
import * as task from 'azure-pipelines-task-lib/task';
import { TaskResult } from 'azure-pipelines-task-lib/task';
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { Build, BuildRestClient } from 'azure-devops-extension-api/Build';
import { getClient } from 'azure-devops-extension-api';

function handleTerraformOutput(terraformPath: string, filePath: string, workingDirectory: string, inferArtifactName: boolean) {
  const terraformTool = task.tool(terraformPath);
  terraformTool.arg(['show', filePath]);

  const result = terraformTool.execSync(<IExecOptions>{
    cwd: workingDirectory,
    silent: true
  });

  if (result.code != 0) {
    const error = result?.error?.message ?? result?.stderr ?? 'Unknown Error';
    throw `Terraform Output failed with Exit Code: ${result.code}
      Error Message: ${error}`;
  }

  task.debug(`Output file fetched: ${result.stdout}`);
  let artifactName = task.getInput('artifactName');
  if (!artifactName) {
    inferArtifactName = true;
    task.debug('artifactName is empty, inferring from filename');
  }

  if (inferArtifactName) {
    const file = path.parse(filePath);
    if (!file) {
      throw `Unable to infer filename from ${filePath}`;
    }

    artifactName = file.name;
  }

  const stagingPath = task.getVariable('Build.ArtifactStagingDirectory') ?? task.getVariable('System.ArtifactsDirectory');
  const outputFile = path.join(stagingPath, artifactName);
  task.writeFile(outputFile, result.stdout);
  task.debug(`Output file written: ${outputFile}`);
  task.addAttachment('terraform.plan', artifactName, outputFile);
  console.log(`Uploaded Plan Output.`);
}

async function handlePullRequestOutput(pullRequest: any) {
  const buildClient: BuildRestClient = getClient(BuildRestClient);
  const builds = await buildClient.getBuilds(pullRequest.repository.id, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, pullRequest.sourceRefName);
  if (builds.length > 0) {
    const build = builds[0];
    const attachments = await buildClient.getAttachments(build.project.id, build.id, "terraform.plan");
    if (attachments.length > 0) {
      const attachment = attachments[0];
      const headers = await getAuthHeaders();
      const response = await fetch(attachment._links.self.href, headers);
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      const attachmentContent = await response.text();
      const stagingPath = task.getVariable('Build.ArtifactStagingDirectory') ?? task.getVariable('System.ArtifactsDirectory');
      const outputFile = path.join(stagingPath, attachment.name);
      task.writeFile(outputFile, attachmentContent);
      task.debug(`Output file written: ${outputFile}`);
      task.addAttachment('terraform.plan', attachment.name, outputFile);
      console.log(`Uploaded Plan Output.`);
    }
  }
}

async function run() {
  let terraformPath: string;
  try {
    terraformPath = task.which('terraform', true);
  } catch (err) {
    throw 'Terraform CLI not found.';
  }

  const useGlobPattern = task.getBoolInput('useGlobPattern');
  if (useGlobPattern) {
    const defaultWorkingDirectory = task.getVariable('System.DefaultWorkingDirectory');

    let searchDirectory = task.getInput('searchDirectory');
    if (searchDirectory) {
      if (defaultWorkingDirectory && !path.isAbsolute(searchDirectory)) {
        searchDirectory = path.join(defaultWorkingDirectory, searchDirectory);
      }
    } else {
      searchDirectory = defaultWorkingDirectory;
    }

    const findOptions = <task.FindOptions>{
      allowBrokenSymbolicLinks: true,
      followSpecifiedSymbolicLink: true,
      followSymbolicLinks: true
    };

    const globPattern = task.getInput('outputFilePattern');
    const result = task.findMatch(searchDirectory, globPattern, findOptions);
    const outputFilesCount = result ? result.length : 0;

    task.debug(`Found ${outputFilesCount} Terraform Output files`);
    if (outputFilesCount === 0) {
      throw `Failed to find Terraform Output files using: ${globPattern}`;
    }

    result.forEach(element => {
      const workingDirectory = path.dirname(element);
      const outputFilePath = path.relative(workingDirectory, element);
      handleTerraformOutput(terraformPath, outputFilePath, workingDirectory, true);
    });
  } else {
    const outputFilePath = task.getPathInput('outputFilePath');
    const workingDirectory = path.dirname(outputFilePath);
    const inferArtifactName = task.getBoolInput('inferArtifactName');
    handleTerraformOutput(terraformPath, outputFilePath, workingDirectory, inferArtifactName);
  }

  const pullRequest = task.getVariable('System.PullRequest.PullRequestId');
  if (pullRequest) {
    await handlePullRequestOutput(pullRequest);
  }
}

run()
  .then(() => {
    task.setResult(TaskResult.Succeeded, '');
  })
  .catch(error => {
    task.setResult(TaskResult.Failed, error);
  });
