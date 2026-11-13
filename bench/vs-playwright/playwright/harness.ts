import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Page, test as base } from "@playwright/test";

// @ts-ignore shared world maker (plain JS)
import { makeWorld } from "../app/world.mjs";

type World = { email: string; password: string; admin_email: string; profile: string; admin_profile: string; sid: string; admin_sid: string };

/** Each test gets its own world: a center, a staff member and an instructor, signed in. */
export const test = base.extend<{ world: World }>({
    world: async ({ baseURL }, use) => use(await makeWorld(baseURL!)),
});
export { expect };

export async function signInAs(context: BrowserContext, sid: string, baseURL: string) {
    await context.clearCookies();
    await context.addCookies([{ name: "sid", value: sid, url: baseURL }]);
}

/** Console errors, page errors and failed requests from now on. */
export function watchErrors(page: Page) {
    const errors: string[] = [];
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
    page.on("response", (r) => {
        if (r.status() >= 400 && !r.url().includes("favicon")) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
    // a request cancelled because the page navigated away is not a failure
    page.on("requestfailed", (r) => {
        if (r.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`failed ${r.url()}: ${r.failure()?.errorText}`);
    });
    return errors;
}

/** The design checks a page must pass: no sideways scroll, a main heading, no errors, axe, tap targets. */
export async function checkDesign(page: Page, label: string, errors: string[], { touch = false } = {}) {
    await page.waitForLoadState("load");
    await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", "true");
    await expect.soft(page.getByRole("heading", { level: 1 }), `${label}: a main heading`).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(overflow, `${label}: scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);

    expect.soft(errors, `${label}: console, page or request errors`).toEqual([]);
    errors.length = 0;

    const axe = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .disableRules(["color-contrast"])
        .analyze();
    const serious = axe.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect.soft(serious, `${label}: accessibility violations`).toEqual([]);

    if (touch) {
        const small = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]')]
                .filter((el) => {
                    const style = getComputedStyle(el);
                    if (style.visibility === "hidden" || style.display === "none") return false;
                    const label = el.closest("label")?.getBoundingClientRect();
                    if (label && label.width >= 24 && label.height >= 24) return false;
                    if (el.tagName === "A" && style.display === "inline") return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
                })
                .map((el) => {
                    const r = el.getBoundingClientRect();
                    return `"${(el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`;
                })
        );
        expect.soft(small, `${label}: tap targets under 24px`).toEqual([]);
    }
}

/** The newest email to `to` in the Mailpit-shaped mailbox, polled until it arrives. */
export async function newestMail(baseURL: string, to: string): Promise<{ Subject: string; Text: string }> {
    let found: { Subject: string; Text: string } | undefined;
    await expect
        .poll(
            async () => {
                const list = await (await fetch(`${baseURL}/mailpit/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`)).json();
                const id = list.messages?.[0]?.ID;
                if (!id) return false;
                found = await (await fetch(`${baseURL}/mailpit/api/v1/message/${id}`)).json();
                return true;
            },
            { message: `an email to ${to}`, timeout: 15_000 }
        )
        .toBe(true);
    return found!;
}
