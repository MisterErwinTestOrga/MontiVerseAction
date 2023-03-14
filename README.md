# GitLab Pipeline trigger action

This GitHub action triggers and waits for a GitLab pipeline to complete.

## Inputs

### `host`

The GitLab host to trigger the pipeline. Default `gitlab.com`.

### `id`

**Required** The ID or URL-encoded path of the project owned by the authenticated user.

### `variables`

A map of key-valued strings containing the pipeline variables. For example: `{ VAR1: "value1", VAR2: "value2" }`.. Default `"World"`.

## Outputs

### `status`

The status of the pipeline.

## Example usage

```yaml
uses: actions/gitlab-pipeline-trigger-action@v1
with:
  id: '123'
```

## Build action

```bash
npm run build
```

Then commit the changes to the `dist` folder.
