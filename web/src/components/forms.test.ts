/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Our <Button> is type="button" unless it says otherwise, so a form whose submit is a <Button> without
 * type="submit" does nothing when tapped (what broke "Sign in" on iPhone). Every form with a <Button>
 * in it must have a type="submit" one.
 */

const dir = import.meta.dirname;
const files = fs.readdirSync(dir).filter((name) => name.endsWith(".tsx"));

describe("forms", () => {
  it("finds the forms it checks", () => {
    const withForms = files.filter((name) => fs.readFileSync(path.join(dir, name), "utf8").includes("<form"));
    expect(withForms).toEqual(expect.arrayContaining(["SignIn.tsx", "PeopleSettings.tsx", "Composer.tsx", "Dialogs.tsx"]));
  });

  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    const forms = [...source.matchAll(/<form[\s>][\s\S]*?<\/form>/g)].map((match) => match[0]);
    if (!forms.length) continue;
    it(`${name}: every form with a <Button> submits with one`, () => {
      for (const form of forms) {
        if (!form.includes("<Button")) continue;
        expect(form, `a form in ${name} has no type="submit" button`).toMatch(/<Button\b(?:=>|[^>])*?\btype="submit"/);
      }
    });
  }
});
