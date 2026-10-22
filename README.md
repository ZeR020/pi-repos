# pi-repos

Read GitHub repositories as if they were local in Pi.

Maintained by [ZeR020](https://github.com/ZeR020).

`pi-repos` gives agents a small set of repository tools for finding GitHub repos, searching code examples, listing files, reading code, finding files by glob, and grepping source. It uses GitHub APIs plus a local archive cache so repeated reads/searches are fast without cloning into your current project.

## Installation

Install from GitHub:

```bash
pi install git:github.com/ZeR020/pi-repos
```

For local development:

```bash
pi -e /absolute/path/to/pi-repos
# or
pi install /absolute/path/to/pi-repos
```

## Tools

| Tool | Purpose |
| --- | --- |
| `repo_find` | Search GitHub repositories by query. |
| `repo_code_search` | Search code across GitHub for examples, APIs, symbols, or implementation patterns. |
| `repo_list` | List a directory in a remote GitHub repository. Accepts GitHub tree URLs. |
| `repo_read` | Read a file from a remote repository, using cached archives when possible. Accepts GitHub blob URLs. |
| `repo_find_files` | Find files in a remote repository by glob. |
| `repo_grep` | Search file contents in a remote repository with archive + ripgrep acceleration when available. |

## Examples

```text
Find the React repository and inspect its package layout.
```

```text
Find TypeScript examples of virtualized tables across open source projects.
```

```text
Use repo_grep to search vercel/next.js for createIncrementalCache.
```

```text
Read README.md from github.com/earendil-works/pi-mono.
```

```text
Read https://github.com/owner/repo/blob/main/src/example.ts.
```

## Configuration

The extension reads these optional environment variables:

| Variable | Description |
| --- | --- |
| `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`, `GITHUB_PERSONAL_ACCESS_TOKEN` | Token for higher GitHub API limits. If absent, the extension tries `gh auth token`. |
| `PI_REPOS_CACHE_DIR` | Cache root for downloaded repository archives. Defaults to `~/.cache/pi-repos`. |
| `PI_REPOS_REF_REFRESH_MS` | How long cached ref-to-commit lookups are considered fresh. Defaults to 5 minutes. |

## Development

```bash
npm install --ignore-scripts
npm run check
pi -e .
```

## Notes

- The package uses Pi's package manifest under the `pi` key and exposes `./src/index.ts` as the extension entry point.
- Runtime GitHub archive caches are kept outside the package directory.
- Extensions run with full local permissions; review third-party Pi packages before installing them.
