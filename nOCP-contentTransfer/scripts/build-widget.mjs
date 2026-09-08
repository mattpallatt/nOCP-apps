// Bundles src/widget.tsx with esbuild's JS API instead of the plain CLI,
// because Axiom's default font stack needs a plugin the CLI can't express.
//
// @optiaxiom/globals pulls in Fontsource's variable-font CSS (Roboto /
// Roboto Condensed / Roboto Mono) as a side-effect import. Those stylesheets
// reference their own .woff2 files with relative url(./files/...) paths -
// meaningless once bundled into a single inlined <style> tag with no static
// file hosting behind it (404 either way). data: URIs "fix" the 404 but the
// real CMS host's CSP is font-src https: — data: font URIs get silently
// blocked there even though they render fine in a plain browser tab. This
// is a known, already-solved problem: the original OCPUI/Frontify-OCP-UI-
// Extension repo hit the exact same thing (see its CLAUDE.md) and fixed it
// by rewriting those three stylesheets' relative paths to jsDelivr's public
// npm mirror before the bundler ever resolves them as local assets — an
// absolute https:// URL satisfies the CSP, and jsDelivr serves the exact
// same files (verified: access-control-allow-origin: *, long-lived caching).
// This plugin is the esbuild-native port of that same fix.
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
