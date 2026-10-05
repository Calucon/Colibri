import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
};

// Every script `npm publish` runs on its own, by name. See
// https://docs.npmjs.com/cli/using-npm/scripts#npm-publish
const PUBLISH_LIFECYCLE = ['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish'];

describe('package.json scripts', () => {
    // A script named `publish` is not an alias npm runs instead of publishing - it is a hook npm
    // runs *after* publishing. One that itself calls `npm publish` therefore publishes, then tries
    // to publish the same version again, which fails and turns a successful release into a
    // non-zero exit.
    it.each(PUBLISH_LIFECYCLE)('the %s hook does not call npm publish again', hook => {
        expect(pkg.scripts[hook] ?? '').not.toMatch(/\bnpm\s+publish\b/);
    });
});
