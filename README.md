# pi-orchard

Extensions for the pi coding agent (`@earendil-works/pi-coding-agent`) that let an agent work with less hand-holding and keep a guard on what it does.

| Package | What it does |
| --- | --- |
| [`pi-automode`](packages/pi-automode) | Checks every tool call before it runs. Permission rules decide the clear cases; a classifier model judges the rest; anything unclear goes to you. |
| [`pi-subagent`](packages/pi-subagent) | Gives the agent a `subagent` tool that runs a task in a separate pi process, in the foreground or in the background. When `pi-automode` is installed, the subagent is guarded too. |

The two packages work alone. Together, a subagent can do its work on a cheap model while its tool calls are checked by a stronger one.

## Requirements

- pi `1.2.0` or newer.
- Node.js with built-in TypeScript support to run the tests (`node --test` runs the `.ts` files directly). The type definitions target Node 24.

## Install

The packages are not on npm. Clone the repository, install the dependencies, and point pi at a package directory:

```sh
git clone https://github.com/henry40408/pi-orchard.git
cd pi-orchard
npm install

# Try one for a single run:
pi -e ./packages/pi-automode -e ./packages/pi-subagent

# Or install them for good (add --local to write to .pi/settings.json):
pi install ./packages/pi-automode
pi install ./packages/pi-subagent
```

Read the source before you install an extension: it runs with your permissions.

## Development

```sh
npm test          # node --test over every package
npm run typecheck # tsc --noEmit
```

The root `package.json` is an npm workspace. pi, its UI library and `typebox` are peer dependencies of the packages (`^1.2.0`), and the repository pins the versions it is tested with.

## License

See [LICENSE.txt](LICENSE.txt).
