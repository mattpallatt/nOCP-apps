// Bundles src/widget.tsx with esbuild's JS API instead of the plain CLI,
// because Axiom's default font stack needs a plugin the CLI can't express.
// Ported verbatim from nocp-frontify's scripts/build-widget.mjs — see that
// file's header comment for the full rationale (short version: Fontsource's
// bundled font CSS references relative url(./files/...) paths that 404 once
// inlined, data: URIs "fix" the 404 but get blocked by the real CMS host's
// font-src https: CSP, so this plugin rewrites those paths to jsDelivr's
// public npm mirror before esbuild ever resolves them as local assets).
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';

const FONTSOURCE_PACKAGES = ['roboto', 'roboto-condensed', 'roboto-mono'];

function fontsourceAbsoluteUrls() {
  return {
    name: 'fontsource-absolute-urls',
    setup(pluginBuild) {
      const filter = new RegExp(
        `@fontsource-variable[\\\\/](${FONTSOURCE_PACKAGES.join('|')})[\\\\/]index\\.css$`,
      );
      pluginBuild.onLoad({filter}, (args) => {
        const match = args.path.match(filter);
        const pkg = match[1];
        const version = JSON.parse(
          readFileSync(
            new URL(`../node_modules/@fontsource-variable/${pkg}/package.json`, import.meta.url),
            'utf-8',
          ),
        ).version;
        const css = readFileSync(args.path, 'utf-8').replace(
          /url\(\.\/files\//g,
          `url(https://cdn.jsdelivr.net/npm/@fontsource-variable/${pkg}@${version}/files/`,
        );
        return {contents: css, loader: 'css'};
      });
    },
  };
}

await build({
  entryPoints: ['src/widget.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  outdir: 'dist/widgetbuild',
  plugins: [fontsourceAbsoluteUrls()],
});
