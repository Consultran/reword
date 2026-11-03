// Tells the agent which git branch a reviewed page was built from, based on the page's URL.
// Cloudflare preview URLs carry the branch name (with "/" and other symbols turned into "-")
// or a version ID that doesn't name the branch at all.

const CLOUDFLARE_VERSION_ID = /^[0-9a-f]{8}$/;

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local") || host.endsWith(".test");
}

/** One line for the prompt header: where the page came from and which branch to apply changes to. */
export function describeDeployment(pageUrl: string): string {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return "Unknown. Ask which branch to apply these changes to.";
  }

  if (isLocalHost(host)) return `Local dev server (${host}). Apply to the branch currently checked out.`;

  const labels = host.split(".");

  if (host.endsWith(".workers.dev") && labels.length >= 4) {
    // <branch-alias>-<worker>.<account>.workers.dev, <version-id>-<worker>.<account>.workers.dev or <worker>.<account>.workers.dev
    const label = labels[0]!;
    const prefix = label.split("-")[0]!;
    if (CLOUDFLARE_VERSION_ID.test(prefix)) {
      return `Cloudflare Workers commit preview (version ${prefix}). This URL does not name the branch: find the pull request whose Cloudflare comment links ${host} (gh pr list, gh pr view --comments) and use its branch.`;
    }
    return `Cloudflare Workers preview "${label}". A branch preview is "<branch>-<worker name>", with "/" and other symbols in the branch turned into "-". Remove the Worker name (the "name" in wrangler.jsonc/wrangler.toml) from the end, then match what's left against git branch -a. If nothing is left, this is the production deploy of the default branch.`;
  }

  if (host.endsWith(".pages.dev")) {
    // <branch-alias or deployment-id>.<project>.pages.dev, or <project>.pages.dev for production
    if (labels.length === 3) return "Cloudflare Pages production deploy. Apply to the default branch.";
    const alias = labels[0]!;
    if (CLOUDFLARE_VERSION_ID.test(alias)) {
      return `Cloudflare Pages deployment preview (${alias}). This URL does not name the branch: find the pull request whose Cloudflare comment links ${host} and use its branch.`;
    }
    return `Cloudflare Pages branch preview "${alias}" ("/" and other symbols in the branch are turned into "-"). Match it against git branch -a.`;
  }

  return `Custom domain (${host}). The URL doesn't name a branch. It's usually the production deploy of the default branch, but it could be a staging site: if you're not already on the default branch, confirm with the user before switching.`;
}
