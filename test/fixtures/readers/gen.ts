// Generates the API-shaped JSON fixtures (deterministic). Run: node test/fixtures/readers/gen.ts
// Shapes follow the real GitHub REST, GitHub GraphQL, npm registry and Kubernetes documents
// field for field; the values are invented.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.github.com';

function user(login: string, id: number, type = 'User') {
  return {
    login, id, node_id: Buffer.from(`04:User${id}`).toString('base64').replace(/=+$/, ''),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`, gravatar_id: '',
    url: `${API}/users/${login}`, html_url: `https://github.com/${login}`,
    followers_url: `${API}/users/${login}/followers`, following_url: `${API}/users/${login}/following{/other_user}`,
    gists_url: `${API}/users/${login}/gists{/gist_id}`, starred_url: `${API}/users/${login}/starred{/owner}{/repo}`,
    subscriptions_url: `${API}/users/${login}/subscriptions`, organizations_url: `${API}/users/${login}/orgs`,
    repos_url: `${API}/users/${login}/repos`, events_url: `${API}/users/${login}/events{/privacy}`,
    received_events_url: `${API}/users/${login}/received_events`, type, user_view_type: 'public', site_admin: false,
  };
}

const LICENSES: Record<string, [string, string]> = {
  mit: ['MIT License', 'MIT'], 'apache-2.0': ['Apache License 2.0', 'Apache-2.0'], 'bsd-3-clause': ['BSD 3-Clause "New" or "Revised" License', 'BSD-3-Clause'],
};

function repo(i: number, owner: string, ownerId: number, name: string, desc: string | null, lang: string | null, stars: number, forks: number, issues: number, topics: string[], lic: string | null, created: string, pushed: string, homepage: string | null, ownerType = 'User') {
  const full = `${owner}/${name}`;
  const u = `${API}/repos/${full}`;
  return {
    id: 1296269 + i * 7919, node_id: Buffer.from(`010:Repository${1296269 + i * 7919}`).toString('base64').replace(/=+$/, ''),
    name, full_name: full, private: false, owner: user(owner, ownerId, ownerType), html_url: `https://github.com/${full}`,
    description: desc, fork: false, url: u, forks_url: `${u}/forks`, keys_url: `${u}/keys{/key_id}`,
    collaborators_url: `${u}/collaborators{/collaborator}`, teams_url: `${u}/teams`, hooks_url: `${u}/hooks`,
    issue_events_url: `${u}/issues/events{/number}`, events_url: `${u}/events`, assignees_url: `${u}/assignees{/user}`,
    branches_url: `${u}/branches{/branch}`, tags_url: `${u}/tags`, blobs_url: `${u}/git/blobs{/sha}`,
    git_tags_url: `${u}/git/tags{/sha}`, git_refs_url: `${u}/git/refs{/sha}`, trees_url: `${u}/git/trees{/sha}`,
    statuses_url: `${u}/statuses/{sha}`, languages_url: `${u}/languages`, stargazers_url: `${u}/stargazers`,
    contributors_url: `${u}/contributors`, subscribers_url: `${u}/subscribers`, subscription_url: `${u}/subscription`,
    commits_url: `${u}/commits{/sha}`, git_commits_url: `${u}/git/commits{/sha}`, comments_url: `${u}/comments{/number}`,
    issue_comment_url: `${u}/issues/comments{/number}`, contents_url: `${u}/contents/{+path}`,
    compare_url: `${u}/compare/{base}...{head}`, merges_url: `${u}/merges`, archive_url: `${u}/{archive_format}{/ref}`,
    downloads_url: `${u}/downloads`, issues_url: `${u}/issues{/number}`, pulls_url: `${u}/pulls{/number}`,
    milestones_url: `${u}/milestones{/number}`, notifications_url: `${u}/notifications{?since,all,participating}`,
    labels_url: `${u}/labels{/name}`, releases_url: `${u}/releases{/id}`, deployments_url: `${u}/deployments`,
    created_at: created, updated_at: pushed.replace(/T\d\d/, 'T23'), pushed_at: pushed,
    git_url: `git://github.com/${full}.git`, ssh_url: `git@github.com:${full}.git`, clone_url: `https://github.com/${full}.git`,
    svn_url: `https://github.com/${full}`, homepage, size: 1000 + ((i * 7717) % 90000), stargazers_count: stars, watchers_count: stars,
    language: lang, has_issues: true, has_projects: i % 3 !== 0, has_downloads: true, has_wiki: i % 2 === 0, has_pages: i % 4 === 0,
    has_discussions: i % 5 === 0, forks_count: forks, mirror_url: null, archived: false, disabled: false, open_issues_count: issues,
    license: lic ? { key: lic, name: LICENSES[lic][0], spdx_id: LICENSES[lic][1], url: `${API}/licenses/${lic}`, node_id: 'MDc6TGljZW5zZTEz' } : null,
    allow_forking: true, is_template: false, web_commit_signoff_required: false, topics, visibility: 'public',
    forks, open_issues: issues, watchers: stars, default_branch: i % 3 === 0 ? 'master' : 'main',
  };
}

const SEARCH: [string, string, number, string, string | null, number, number, number, string[], string | null][] = [
  ['vercel', 'next.js', 14985, 'The React Framework', 'JavaScript', 131000, 28400, 3100, ['react', 'nextjs', 'ssr', 'vercel', 'blog', 'static-site-generator'], 'mit'],
  ['facebook', 'react', 69631, 'The library for web and native user interfaces.', 'JavaScript', 236000, 48600, 980, ['react', 'javascript', 'library', 'ui', 'frontend', 'declarative'], 'mit'],
  ['remix-run', 'react-router', 64235965, 'Declarative routing for React', 'TypeScript', 54800, 10600, 160, ['react', 'router', 'routing'], 'mit'],
  ['TanStack', 'query', 72518640, '🤖 Powerful asynchronous state management, server-state utilities and data fetching for the web. TS/JS, React Query, Solid Query, Svelte Query and Vue Query.', 'TypeScript', 45200, 3300, 90, ['react', 'hooks', 'async', 'data-fetching', 'cache'], 'mit'],
  ['pmndrs', 'zustand', 45921, '🐻 Bear necessities for state management in React', 'TypeScript', 52600, 1650, 4, ['react', 'state-management', 'hooks', 'redux'], 'mit'],
  ['mui', 'material-ui', 33663218, 'Material UI: Comprehensive React component library that implements Google\'s Material Design. Free forever.', 'JavaScript', 95700, 32400, 1600, ['react', 'design-system', 'material-design', 'component-library'], 'mit'],
  ['react-hook-form', 'react-hook-form', 53986236, '📋 React Hooks for form state management and validation (Web + React Native)', 'TypeScript', 43000, 2200, 120, ['react', 'forms', 'validation', 'hooks'], 'mit'],
  ['testing-library', 'react-testing-library', 36254102, '🐐 Simple and complete React DOM testing utilities that encourage good testing practices.', 'JavaScript', 19100, 1150, 60, ['react', 'testing', 'jest', 'dom'], 'mit'],
  ['preactjs', 'preact', 26872990, '⚛️ Fast 3kB React alternative with the same modern API. Components & Virtual DOM.', 'JavaScript', 37500, 1980, 160, ['preact', 'react', 'vdom', 'jsx'], 'mit'],
  ['react-native-community', 'react-native-maps', 23149811, 'React Native Mapview component for iOS + Android', 'Java', 15300, 4900, 190, ['react-native', 'maps'], 'mit'],
  ['ant-design', 'ant-design', 12101536, 'An enterprise-class UI design language and React UI library', 'TypeScript', 93600, 51000, 1100, ['react', 'ui', 'design-system', 'antd', 'enterprise'], 'mit'],
  ['storybookjs', 'storybook', 22632046, 'Storybook is the industry standard workshop for building, documenting, and testing UI components in isolation', 'TypeScript', 85700, 9400, 2200, ['react', 'components', 'ui', 'testing', 'documentation'], 'mit'],
  ['reduxjs', 'redux', 13142323, 'A JS library for predictable global state management', 'TypeScript', 61000, 15200, 40, ['redux', 'state', 'functional-programming'], 'mit'],
  ['jaredpalmer', 'formik', 4060939, 'Build forms in React, without the tears 😭 ', 'TypeScript', 34000, 2800, 800, ['react', 'forms', 'validation'], 'apache-2.0'],
  ['airbnb', 'visx', 698437, '🐯 visx | visualization components', 'TypeScript', 19600, 730, 120, ['react', 'd3', 'charts', 'visualization'], 'mit'],
  ['framer', 'motion', 34262434, 'A modern animation library for React and JavaScript', 'TypeScript', 26700, 900, 250, ['animation', 'react', 'gestures'], 'mit'],
  ['react-dnd', 'react-dnd', 6233016, 'Drag and Drop for React', 'TypeScript', 21200, 2000, 450, ['react', 'drag-and-drop'], 'mit'],
  ['ianstormtaylor', 'slate', 1102151, 'A completely customizable framework for building rich text editors. (Currently in beta.)', 'TypeScript', 30500, 3300, 640, ['editor', 'rich-text', 'react'], 'mit'],
  ['react-boilerplate', 'react-boilerplate', 15100561, '🔥 A highly scalable, offline-first foundation with the best developer experience and a focus on performance and best practices.', 'JavaScript', 29500, 11300, 0, ['boilerplate', 'react', 'redux'], 'mit'],
  ['alan2207', 'bulletproof-react', 30289519, '🛡️ ⚛️ A simple, scalable, and powerful architecture for building production ready React applications. ', 'TypeScript', 31400, 2800, 10, ['react', 'architecture', 'best-practices'], 'mit'],
  ['enzymejs', 'enzyme', 15069512, 'JavaScript Testing utilities for React', 'JavaScript', 19900, 2000, 280, ['react', 'testing'], 'mit'],
  ['react-grid-layout', 'react-grid-layout', 1150214, 'A draggable and resizable grid layout with responsive breakpoints, for React.', 'TypeScript', 21000, 2600, 260, ['react', 'grid', 'layout'], 'mit'],
  ['streamich', 'react-use', 9076149, 'React Hooks — 👍', 'TypeScript', 42300, 3200, 600, ['react', 'hooks'], null],
  ['react-bootstrap', 'react-bootstrap', 6853419, 'Bootstrap components built with React', 'TypeScript', 22500, 3600, 160, ['react', 'bootstrap'], 'mit'],
  ['downshift-js', 'downshift', 2440337, '🏎 A set of primitives to build simple, flexible, WAI-ARIA compliant React autocomplete, combobox or select dropdown components.', 'TypeScript', 12200, 930, 70, ['react', 'autocomplete', 'a11y'], 'mit'],
  ['styled-components', 'styled-components', 20658570, 'Visual primitives for the component age. Use the best bits of ES6 and CSS to style your apps without stress 💅', 'TypeScript', 40900, 2500, 70, ['css', 'react', 'css-in-js'], 'mit'],
  ['react-spring', 'react-spring', 18010036, '✌️ A spring physics based React animation library', 'TypeScript', 28500, 1200, 120, ['animation', 'react', 'spring'], 'mit'],
  ['react-static', 'react-static', 22311512, '⚛️ 🚀 A progressive static site generator for React.', 'JavaScript', 10300, 750, 70, ['react', 'static-site'], 'mit'],
  ['react-pdf', 'react-pdf', 4545113, null as any, 'TypeScript', 9800, 900, 140, ['pdf', 'react'], 'mit'],
  ['react-redux', 'react-redux', 13142324, 'Official React bindings for Redux', 'TypeScript', 23400, 3400, 20, ['react', 'redux'], 'mit'],
];

function search() {
  const items = SEARCH.map(([owner, name, oid, desc, lang, stars, forks, issues, topics, lic], i) => {
    const y = 2013 + (i % 10);
    const r = repo(i + 1, owner, oid, name, desc, lang, stars, forks, issues, topics, lic, `${y}-0${1 + (i % 9)}-1${i % 9}T0${i % 9}:2${i % 6}:11Z`, `2026-11-0${1 + (i % 4)}T1${i % 9}:0${i % 6}:44Z`, i % 3 ? `https://${name}.dev` : null, i % 2 ? 'Organization' : 'User');
    return { ...r, score: 1.0 };
  });
  return { total_count: 1843211, incomplete_results: false, items };
}

function repoFull() {
  const r = repo(0, 'octocat', 1, 'Hello-World', 'My first repository on GitHub!', 'Ruby', 2654, 2501, 1453, ['octocat', 'atom', 'electron', 'api'], 'mit', '2011-01-26T19:01:12Z', '2026-10-30T18:02:08Z', 'https://github.com');
  return {
    ...r,
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    temp_clone_token: '', custom_properties: {}, organization: undefined, network_count: 2501, subscribers_count: 1729,
  };
}

function npm() {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = { created: '2013-02-14T21:40:34.512Z', modified: '2026-10-21T09:12:51.002Z' };
  const vs = ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.4.1', '0.5.0', '1.0.0', '1.0.1', '1.1.0', '1.2.0', '1.3.0', '1.3.1', '1.4.0', '2.0.0', '2.0.1', '2.1.0', '2.2.0', '2.2.1', '2.3.0', '3.0.0-beta.1', '3.0.0-beta.2', '3.0.0'];
  vs.forEach((v, i) => {
    const major = Number(v[0]);
    versions[v] = {
      name: 'tiny-glob-walker', version: v, description: 'Fast and minimal glob matcher and directory walker with zero dependencies',
      main: major >= 3 ? 'dist/index.cjs' : 'index.js', ...(major >= 3 ? { module: 'dist/index.mjs', types: 'dist/index.d.ts', exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } } } : {}),
      scripts: { test: major >= 2 ? 'vitest run' : 'mocha test', ...(major >= 3 ? { build: 'tsup src/index.ts' } : {}) },
      repository: { type: 'git', url: 'git+https://github.com/jdoe/tiny-glob-walker.git' }, keywords: ['glob', 'walk', 'fs', 'files'],
      author: { name: 'Jane Doe', email: 'jane@example.com', url: 'https://janedoe.dev' }, license: 'MIT',
      bugs: { url: 'https://github.com/jdoe/tiny-glob-walker/issues' }, homepage: 'https://github.com/jdoe/tiny-glob-walker#readme',
      dependencies: major >= 2 ? {} : { minimatch: '^0.2.' + i, graceful_fs: '~1.2.0' },
      devDependencies: major >= 2 ? { vitest: '^0.' + (20 + i) + '.0', typescript: '^5.' + (i % 5) + '.0', ...(major >= 3 ? { tsup: '^8.0.0' } : {}) } : { mocha: '^1.' + i + '.0', should: '^1.2.0' },
      engines: { node: major >= 3 ? '>=18' : major >= 2 ? '>=14' : '>=0.8' },
      gitHead: (0x9f3a2b1c + i * 0x1111111).toString(16).padEnd(40, '0'),
      _id: `tiny-glob-walker@${v}`, _nodeVersion: major >= 2 ? '20.' + i + '.0' : '0.10.' + i, _npmVersion: major >= 2 ? '10.2.' + i : '1.4.' + i,
      dist: {
        integrity: 'sha512-' + Buffer.from('integrity-of-' + v).toString('base64') + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==',
        shasum: (0xabc123 + i * 77).toString(16).padEnd(40, '7'), tarball: `https://registry.npmjs.org/tiny-glob-walker/-/tiny-glob-walker-${v}.tgz`,
        fileCount: 4 + i, unpackedSize: 9000 + i * 812,
        signatures: [{ keyid: 'SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA', sig: 'MEUCIQDx' + i + 'v1V0exampleSignature' }],
      },
      _npmUser: { name: 'jdoe', email: 'jane@example.com' }, directories: {}, maintainers: [{ name: 'jdoe', email: 'jane@example.com' }],
      _hasShrinkwrap: false,
    };
    time[v] = new Date(Date.UTC(2013 + Math.floor(i / 2), (i * 5) % 12, 1 + i, 10, i, 0)).toISOString();
  });
  return {
    _id: 'tiny-glob-walker', _rev: '87-4be9f1cd0e2a9a5d6e0d3b6f0d1b2c3a', name: 'tiny-glob-walker',
    'dist-tags': { latest: '3.0.0', beta: '3.0.0-beta.2' }, versions, time,
    maintainers: [{ name: 'jdoe', email: 'jane@example.com' }, { name: 'rsmith', email: 'r.smith@example.org' }],
    description: 'Fast and minimal glob matcher and directory walker with zero dependencies',
    homepage: 'https://github.com/jdoe/tiny-glob-walker#readme', keywords: ['glob', 'walk', 'fs', 'files'],
    repository: { type: 'git', url: 'git+https://github.com/jdoe/tiny-glob-walker.git' },
    author: { name: 'Jane Doe', email: 'jane@example.com', url: 'https://janedoe.dev' },
    bugs: { url: 'https://github.com/jdoe/tiny-glob-walker/issues' }, license: 'MIT', readmeFilename: 'README.md',
    readme: `# tiny-glob-walker

Fast and minimal glob matcher and directory walker with **zero dependencies**.

## Install

\`\`\`sh
npm install tiny-glob-walker
\`\`\`

## Usage

\`\`\`js
import { glob } from 'tiny-glob-walker';

const files = await glob('src/**/*.ts', { ignore: ['**/*.test.ts'] });
\`\`\`

## API

### glob(pattern, options?)

Returns a promise for an array of matching paths.

- \`cwd\` — directory to search from (default: \`process.cwd()\`)
- \`ignore\` — patterns to skip
- \`dot\` — include dotfiles (default: \`false\`)

### walk(dir, visit)

Calls \`visit(path, stat)\` for every file below \`dir\`. Return \`false\` to skip a directory.

## Benchmarks

| library | ops/sec |
|---|---|
| tiny-glob-walker | 41,200 |
| fast-glob | 33,900 |
| glob | 12,400 |

## License

MIT © [Jane Doe](https://janedoe.dev)
`,
    users: Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil', 'trent', 'victor', 'walter', 'xena', 'yolanda', 'zed', 'amir', 'bea', 'chen', 'dara', 'eli', 'fatima', 'gus', 'hana', 'igor', 'jo'].map((u) => [u, true])),
  };
}

function graphql() {
  const titles = ['Crash when the config file is empty', 'Support for monorepos with pnpm workspaces', 'Docs: clarify the cache option', 'Memory leak in watch mode on Linux', 'Add --json output to the CLI', 'TypeError: Cannot read properties of undefined (reading \'map\')', 'Windows paths with spaces are not escaped', 'Feature request: plugin hooks for transforms'];
  return {
    data: {
      repository: {
        name: 'tiny-glob-walker', stargazerCount: 1204, description: 'Fast and minimal glob matcher',
        issues: {
          totalCount: 87,
          pageInfo: { hasNextPage: true, endCursor: 'Y3Vyc29yOnYyOpHOBf3vXA==' },
          edges: titles.map((t, i) => ({
            cursor: 'Y3Vyc29yOnYyOpHO' + (100 + i),
            node: {
              __typename: 'Issue', number: 340 - i * 7, title: t, state: i % 3 === 0 ? 'CLOSED' : 'OPEN', createdAt: `2026-0${1 + i}-1${i}T08:00:00Z`,
              author: { __typename: 'User', login: ['alice', 'bob', 'carol', 'dave'][i % 4], url: `https://github.com/${['alice', 'bob', 'carol', 'dave'][i % 4]}` },
              labels: { nodes: (i % 2 ? [{ name: 'bug', color: 'd73a4a' }] : [{ name: 'enhancement', color: 'a2eeef' }, { name: 'help wanted', color: '008672' }]) },
              comments: { totalCount: (i * 3) % 11 },
              url: `https://github.com/jdoe/tiny-glob-walker/issues/${340 - i * 7}`,
            },
          })),
        },
      },
    },
  };
}

function events() {
  const actor = (login: string, id: number) => ({ id, login, display_login: login, gravatar_id: '', url: `${API}/users/${login}`, avatar_url: `https://avatars.githubusercontent.com/u/${id}?` });
  const repoRef = { id: 1296269, name: 'octocat/Hello-World', url: `${API}/repos/octocat/Hello-World` };
  return [
    { id: '43982734101', type: 'PushEvent', actor: actor('alice', 101), repo: repoRef, payload: { repository_id: 1296269, push_id: 2207341, size: 2, distinct_size: 2, ref: 'refs/heads/main', head: '7638417db6d59f3c431d3e1f261cc637155684cd', before: '1b6a7c9e0c3f4f3b8e9d2a1c0b9a8f7e6d5c4b3a', commits: [{ sha: '7638417db6d59f3c431d3e1f261cc637155684cd', author: { email: 'alice@example.com', name: 'Alice' }, message: 'Fix the README typo', distinct: true, url: `${API}/repos/octocat/Hello-World/commits/7638417db6d59f3c431d3e1f261cc637155684cd` }] }, public: true, created_at: '2026-11-04T18:22:10Z' },
    { id: '43982731188', type: 'WatchEvent', actor: actor('bob', 102), repo: repoRef, payload: { action: 'started' }, public: true, created_at: '2026-11-04T18:20:51Z' },
    { id: '43982729003', type: 'IssuesEvent', actor: actor('carol', 103), repo: repoRef, payload: { action: 'opened', issue: { number: 1347, title: 'Found a bug', state: 'open', body: 'I am having a problem with this.', labels: [{ name: 'bug' }], comments: 0, html_url: 'https://github.com/octocat/Hello-World/issues/1347' } }, public: true, created_at: '2026-11-04T18:19:02Z' },
    { id: '43982720547', type: 'PullRequestEvent', actor: actor('dave', 104), repo: repoRef, payload: { action: 'closed', number: 1346, pull_request: { number: 1346, title: 'Amazing new feature', state: 'closed', merged: true, additions: 120, deletions: 4, changed_files: 5, html_url: 'https://github.com/octocat/Hello-World/pull/1346' } }, public: true, created_at: '2026-11-04T18:10:40Z' },
    { id: '43982718820', type: 'IssueCommentEvent', actor: actor('erin', 105), repo: repoRef, payload: { action: 'created', issue: { number: 1340, title: 'Spelling error in the README file' }, comment: { body: 'Thanks, fixed in #1346.', html_url: 'https://github.com/octocat/Hello-World/issues/1340#issuecomment-1' } }, public: true, created_at: '2026-11-04T18:02:13Z' },
    { id: '43982711002', type: 'CreateEvent', actor: actor('alice', 101), repo: repoRef, payload: { ref: 'release-2.1', ref_type: 'branch', master_branch: 'main', description: 'My first repository on GitHub!', pusher_type: 'user' }, public: true, created_at: '2026-11-04T17:58:00Z' },
  ];
}

function k8s() {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'checkout-api', namespace: 'shop', uid: '5f3b2a8e-61c4-4b6f-9d1e-0c2a7b9f4e11', resourceVersion: '48211907', generation: 14, creationTimestamp: '2026-03-02T11:04:51Z', labels: { app: 'checkout-api', team: 'payments', tier: 'backend' }, annotations: { 'deployment.kubernetes.io/revision': '14', 'kubectl.kubernetes.io/last-applied-configuration': '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"annotations":{},"name":"checkout-api","namespace":"shop"},"spec":{"replicas":3}}' } },
    spec: {
      replicas: 3, revisionHistoryLimit: 10, selector: { matchLabels: { app: 'checkout-api' } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } },
      template: {
        metadata: { labels: { app: 'checkout-api', team: 'payments' } },
        spec: {
          serviceAccountName: 'checkout', terminationGracePeriodSeconds: 30,
          containers: [
            {
              name: 'api', image: 'registry.example.com/shop/checkout-api:2.14.3', ports: [{ containerPort: 8080, name: 'http', protocol: 'TCP' }],
              env: [{ name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'checkout-db', key: 'url' } } }, { name: 'LOG_LEVEL', value: 'info' }, { name: 'PAYMENTS_TIMEOUT_MS', value: '4000' }],
              resources: { limits: { cpu: '1', memory: '1Gi' }, requests: { cpu: '250m', memory: '512Mi' } },
              readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 10 },
            },
            { name: 'envoy', image: 'envoyproxy/envoy:v1.31.0', ports: [{ containerPort: 9901, name: 'admin', protocol: 'TCP' }], resources: { limits: { cpu: '500m', memory: '256Mi' } } },
          ],
        },
      },
    },
    status: { observedGeneration: 14, replicas: 3, updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3, conditions: [{ type: 'Available', status: 'True', lastUpdateTime: '2026-10-30T08:01:12Z', lastTransitionTime: '2026-03-02T11:05:30Z', reason: 'MinimumReplicasAvailable', message: 'Deployment has minimum availability.' }, { type: 'Progressing', status: 'True', lastUpdateTime: '2026-10-30T08:01:12Z', lastTransitionTime: '2026-03-02T11:04:51Z', reason: 'NewReplicaSetAvailable', message: 'ReplicaSet "checkout-api-7d9f8c6b5" has successfully progressed.' }] },
  };
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
writeFileSync(join(dir, 'github-repo.json'), pretty(repoFull()));
writeFileSync(join(dir, 'github-search.json'), pretty(search()));
writeFileSync(join(dir, 'npm-package.json'), JSON.stringify(npm()));
writeFileSync(join(dir, 'graphql-issues.json'), JSON.stringify(graphql()));
writeFileSync(join(dir, 'github-events.json'), pretty(events()));
writeFileSync(join(dir, 'k8s-deployment.json'), pretty(k8s()));
console.log('fixtures written to', dir);
