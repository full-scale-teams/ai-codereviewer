# AI Code Reviewer

A GitHub Action that reviews a pull request with the OpenAI API and posts its
findings as inline comments.

Reviews are **requested, not automatic**. A developer asks for one by
commenting on the pull request:

```
@openai review
```

Anything typed after the phrase steers the pass:

```
@openai review focus on the transaction boundary in ReportService
```

The action reacts 👀 when it picks the request up and 🚀 when it finishes, and
always leaves a summary comment — including when it finds nothing, so nobody is
left wondering whether it ran.

## Why on request rather than on every pull request

Reviewing automatically on `opened` and `synchronize` means every push spends
API budget, and the comments arrive before the branch is finished. Requesting a
review puts a person in the loop: they ask when the branch is ready, and they
can ask again after pushing fixes.

The `pull_request` event is still supported by the action, so a repository that
wants an automatic pass can have one — see [Automatic reviews](#automatic-reviews).

## Setup

1. Add your OpenAI key as a repository secret named `OPENAI_API_KEY`.
   `GITHUB_TOKEN` is provided by Actions and needs no setup.

2. Add `.github/workflows/ai-code-review.yml`:

```yaml
name: AI Code Review

on:
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number:
        description: "Pull request number to review"
        required: true
        type: string

permissions:
  contents: read
  pull-requests: write
  issues: write # to react to the triggering comment

concurrency:
  group: ai-code-review-${{ github.event.issue.number || inputs.pr_number }}
  cancel-in-progress: false

jobs:
  code_review:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.issue.pull_request != null &&
       contains(github.event.comment.body, '@openai review'))
    runs-on: ubuntu-latest
    steps:
      - name: Review the pull request
        uses: full-scale-teams/ai-codereviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-4o"
          TRIGGER_PHRASE: "@openai review"
          PR_NUMBER: ${{ inputs.pr_number }}
          exclude: "**/*.lock,**/*.json,**/*.md"
```

3. **Merge it to the default branch.** GitHub loads `issue_comment` workflows
   from the default branch only; a copy on a feature branch will never fire.

### Two things that will waste your afternoon if you miss them

- **`actions/checkout` is not needed.** The action reads the diff over the API.
  On an `issue_comment` event a checkout would fetch the default branch anyway,
  not the pull request.
- **The `if:` phrase and `TRIGGER_PHRASE` must match.** The `if:` is a cheap
  pre-filter that stops an unrelated comment from starting a runner; the action
  then does the real matching. The workflow `if:` is **case-sensitive** (GitHub
  expressions have no lowercase function), while the action matches
  case-insensitively — so document the lowercase form to your team.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | — | **Required.** Reads the diff, posts the review. |
| `OPENAI_API_KEY` | — | **Required.** |
| `OPENAI_API_MODEL` | `gpt-4o` | Must support Structured Outputs. |
| `OPENAI_API_ENDPOINT` | `responses` | `responses` or `chat`. See below. |
| `OPENAI_TEMPERATURE` | `0.2` | Dropped automatically for models that reject it. |
| `OPENAI_MAX_OUTPUT_TOKENS` | `2000` | Output ceiling per request. |
| `TRIGGER_PHRASE` | `@openai review` | What a comment must contain. |
| `ALLOWED_ASSOCIATIONS` | `OWNER,MEMBER,COLLABORATOR` | Who may request a review. |
| `PR_NUMBER` | — | For `workflow_dispatch` runs. |
| `PROJECT_CONTEXT` | — | Repository context appended to the instructions. |
| `REVIEW_PROMPT` | — | Replaces the built-in instructions entirely. |
| `exclude` | — | Comma-separated globs to skip. |
| `MAX_FILES` | `40` | Files to review, largest diffs first. |
| `MAX_COMMENTS` | `25` | Comments to post, most severe first. |
| `MAX_REQUEST_CHARS` | `12000` | Diff budget per request. |
| `CONCURRENCY` | `3` | Requests in flight. |

### `PROJECT_CONTEXT` is the highest-leverage input

The built-in instructions know about Laravel and Vue in general. They do not
know that your authorization reads a particular table, or that a hard-coded hex
breaks your dark mode. Feeding those in turns generic advice into findings that
matter:

```yaml
PROJECT_CONTEXT: |
  This is Vue 2.7, not Vue 3 — flag composition-API syntax as a defect.
  API access goes through a Vuex module, a Model and a Resource. A component
  calling axios directly is a defect.
```

### Which endpoint

`responses` is OpenAI's current endpoint and the default here. It is used with
**Structured Outputs** (`strict: true`), so the model's reply is guaranteed to
match the review schema rather than merely being valid JSON — which removes the
"model returned prose, retry the whole call" failure mode. Requests are sent
with `store: false`, so your source is not retained.

`chat` selects the older Chat Completions endpoint. It is kept as a one-line
escape hatch in case an organisation or a model is not enabled for the
Responses API; it is not the recommended path.

The model is deliberately an input rather than pinned in code. `gpt-4o` is the
broadly available default; a stronger current model will find more, at higher
cost per review. Change `OPENAI_API_MODEL` and confirm your organisation has
access to what you set.

### Who may request a review

Comments are gated on GitHub's `author_association`, which arrives in the
webhook payload — no extra API call and no extra token permission. By default
only `OWNER`, `MEMBER` and `COLLABORATOR` can trigger a run, so a drive-by
comment on a public repository cannot spend your API budget. Comments authored
by bots are ignored, which is also what stops the action from triggering itself.

## Automatic reviews

To also run on every push, add a second trigger and widen the `if:`:

```yaml
on:
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize]

jobs:
  code_review:
    if: >-
      github.event_name == 'pull_request' ||
      (github.event.issue.pull_request != null &&
       contains(github.event.comment.body, '@openai review'))
```

On a `pull_request` run the action reviews the whole pull request and stays
silent when it finds nothing, rather than posting a "nothing found" comment on
every push.

> If you make this workflow a **required status check**, a pull request cannot
> merge until the check has run. With a comment-only trigger, that means every
> pull request blocks until somebody requests a review. Keep it optional.

## How it works

1. Resolves the event: a trigger comment (on the conversation or in a review
   thread), a `pull_request` event, or a `workflow_dispatch` with `PR_NUMBER`.
   Anything else exits successfully without spending anything.
2. Fetches the full pull request diff, drops deleted and binary files and
   anything matching `exclude`, and keeps the largest `MAX_FILES`.
3. Sends one request per file — split only when a file exceeds
   `MAX_REQUEST_CHARS` — up to `CONCURRENCY` at a time.
4. Discards any finding not anchored to a line that was actually added, keeps
   the most severe finding per line, and posts the top `MAX_COMMENTS` as one
   review with a summary.

Findings are ranked 🔴 blocker, 🟠 major, 🟡 minor, and `MAX_COMMENTS` truncates
from the bottom, so a cap never hides a blocker.

If GitHub rejects the batch review, each comment is retried individually and
anything still unanchorable is listed in the summary rather than lost.

## Development

```bash
yarn install
yarn test     # builds, bundles, then runs the unit and end-to-end suites
```

`dist/` is committed because that is what GitHub executes. **Editing `src/`
without re-bundling ships nothing** — `yarn test` rebuilds it, and CI fails if
the committed bundle is stale.

The end-to-end suite runs `dist/index.js` as a child process against a local
stub of both APIs, so the event wiring, the diff fetch, the model call and the
comment posting are exercised together.

## License

MIT. See [LICENCE](LICENCE).
