import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkDesign, expect, newestMail, signInAs, test, watchErrors } from "./harness";

test("sign in, wrong password, sign out", async ({ page, world }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(world.email);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Wrong email or password.");
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Email").fill(world.email);
    await page.getByLabel("Password").fill(world.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/home");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to Tock" })).toBeVisible();
});

test("staff cannot open the bug reports", async ({ page, context, world, baseURL }) => {
    await signInAs(context, world.sid, baseURL!);
    await page.goto("/admin/reports");
    await expect(page.getByRole("heading", { level: 1, name: "Not allowed" })).toBeVisible();
});

test("report a problem: staff sends, instructor reads", async ({ page, context, world, baseURL }) => {
    const note = `The history page froze ${world.sid}`;
    await test.step("staff sends a report from the top bar", async () => {
        await signInAs(context, world.sid, baseURL!);
        await page.goto("/students");
        await page.getByRole("button", { name: "Report a problem" }).click();
        const dialog = page.getByRole("dialog", { name: "Report a problem" });
        await expect(dialog.getByRole("textbox", { name: "What went wrong" })).toBeFocused();
        await dialog.getByRole("button", { name: "Send report" }).click();
        await expect(page.getByText("Your report was sent.")).toBeVisible();
        await expect(dialog).toBeHidden();
        await page.getByRole("button", { name: "Report a problem" }).click();
        await dialog.getByRole("textbox", { name: "What went wrong" }).fill(note);
        await dialog.getByRole("button", { name: "Send report" }).click();
        await expect(page.getByText("Your report was sent.").last()).toBeVisible();
        await expect(dialog).toBeHidden();
    });
    await test.step("instructor reads it", async () => {
        await signInAs(context, world.admin_sid, baseURL!);
        await page.goto("/admin/reports");
        await expect(page.getByRole("heading", { level: 1, name: "Bug reports" })).toBeVisible();
        await expect(page.getByText(note)).toBeVisible();
    });
});

test("add a student", async ({ page, context, world, baseURL }) => {
    const errors = watchErrors(page);
    await signInAs(context, world.sid, baseURL!);
    await page.goto("/students");
    await expect(page.getByText("0 students")).toBeVisible();
    await page.getByRole("button", { name: "Add student" }).click();
    await expect(page.getByRole("alert")).toHaveText("Name is required");

    await page.getByLabel("Student name").fill("Ada Lovelace");
    await page.getByLabel("Grade").selectOption("3");
    await page.getByRole("button", { name: "Add student" }).click();
    await expect(page.getByRole("row", { name: /Ada Lovelace 3/ })).toBeVisible();
    await expect(page.getByText("1 student", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("row", { name: /Ada Lovelace 3/ })).toBeVisible();
    expect(errors, "no failed requests or console errors").toEqual([]);
});

test("instructor picks the kiosk way; Clock in shows only the code", async ({ page, context, world, baseURL }) => {
    await signInAs(context, world.admin_sid, baseURL!);
    await page.goto("/settings");
    await page.getByRole("radio", { name: /Showing their code to the kiosk/ }).check();
    await expect(page.getByText(/Saved\. Staff see the new way/)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("radio", { name: /Showing their code to the kiosk/ })).toBeChecked();

    await signInAs(context, world.sid, baseURL!);
    await page.goto("/scan");
    await expect(page.getByRole("textbox", { name: "Clock-in code" })).toBeVisible();
    await expect(page.getByText(/New code in [12]:\d\d/)).toBeVisible();
    await expect(page.getByRole("region", { name: "QR code scanner" })).toHaveCount(0);
});

test("parent signs up with an emailed code", async ({ page, baseURL }) => {
    const email = `parent-${Date.now()}-${Math.random().toString(36).slice(2)}@test.example`;
    await page.goto("/signup");
    await page.getByLabel("Your email").fill(email);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    const mail = await newestMail(baseURL!, email);
    expect(mail.Subject).toBe("Your Tock code");
    const code = /\b(\d{6})\b/.exec(mail.Text)![1];
    await page.getByLabel("Code").fill(code);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Pat Parent" })).toBeVisible();
});

test("kiosk without a camera takes an uploaded photo", async ({ page, context, world, baseURL }) => {
    await signInAs(context, world.sid, baseURL!);
    await page.goto("/kiosk");
    const file = join(import.meta.dirname, "..", "app", "card.png");
    await page.getByLabel("Card photo").setInputFiles(file);
    await expect(page.getByRole("status")).toHaveText(`Photo received: card.png (${readFileSync(file).length} bytes)`);
});

const PAGES = ["/home", "/students", "/settings", "/kiosk"];
for (const [width, height, touch] of [[390, 844, true], [1440, 900, false]] as const) {
    test(`design sweep at ${width}px`, async ({ page, context, world, baseURL }) => {
        await page.setViewportSize({ width, height });
        const errors = watchErrors(page);
        const menus: Record<string, string[]> = {};
        await signInAs(context, world.sid, baseURL!);
        for (const path of PAGES) {
            await page.goto(path);
            await checkDesign(page, `${path} at ${width}`, errors, { touch });
            menus[path] = await page.locator("nav [data-menu]").allInnerTexts();
        }
        for (const path of PAGES) expect.soft(menus[path], `menu on ${path}`).toEqual(menus[PAGES[0]]);
        await signInAs(context, world.admin_sid, baseURL!);
        await page.goto("/admin/reports");
        await checkDesign(page, `/admin/reports at ${width}`, errors, { touch });
    });
}
