import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { type Device, watchAppNote } from "./iphone-deploy";

// A real Release build from `iphone-deploy push a-better-me`: its watch app's profile lists an
// iPhone (00008130-001678C63C20001C) and a Mac, no watch.
const builtApp = path.join(os.homedir(), "Library/Caches/iphone-release-builds/a-better-me/Build/Products/Release-iphoneos/App.app");

const device = (overrides: Partial<Device>): Device => ({
  identifier: "id", name: "Watch", simulated: false, physicalIOS: false, physicalWatch: true,
  iPhone: false, paired: true, booted: true, developerModeDisabled: false, ...overrides,
});

describe.skipIf(!existsSync(builtApp))("watchAppNote", () => {
  it("warns when no known watch is in the watch app's profile", () => {
    const note = watchAppNote(builtApp, [device({ udid: "00008310-000000000000001E" })]);
    expect(Bun.stripANSI(note ?? "").split("\n")[0]).toBe("Watch.app is not signed for any watch Xcode knows, so no watch can install it.");
  });

  it("points at the Watch app when a provisioned watch is known", () => {
    const note = watchAppNote(builtApp, [device({ name: "Stefan's Watch", udid: "00008130-001678c63c20001c" })]);
    expect(note).toBe("Watch.app is signed for Stefan's Watch; install it from the iPhone's Watch app > Available Apps.");
  });

  it("says nothing for an app without a watch app", () => {
    expect(watchAppNote(path.join(builtApp, "Watch/Watch.app"), [])).toBeNull();
  });
});
