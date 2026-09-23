process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

// Behavioral Windows tests of the generated clear helper with mocked cmdlets.
// No actual Windows identity lookup or Scheduled Task mutation is performed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildServeTaskScript, encodePowerShellCommand } from "../dist/index.js";

for (const scenario of ["foreign-owner", "unverified-owner", "lookup-error"]) {
  test(`clear helper never unregisters after ${scenario}`, { skip: process.platform !== "win32" }, () => {
    const script = buildServeTaskScript("unregister");
    const main = script.lastIndexOf("\n$identity = Get-ZswarmIdentity");
    assert.ok(main > 0, "adapt the fixture injection point if the helper layout changes");
    const mockTask =
      scenario === "lookup-error"
        ? "throw 'fixture: task inspection denied'"
        : `return [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = '${scenario === "foreign-owner" ? "S-1-5-21-8-8-8-8888" : ""}' } }`;
    const mocks = `
function Get-ZswarmIdentity { return @{ name = 'CORP\\sam'; sid = 'S-1-5-21-1-2-3-1001' } }
function Get-ZswarmTask { ${mockTask} }
function Stop-ScheduledTask { param($TaskName) $script:stops++ }
function Unregister-ScheduledTask { param($TaskName, $Confirm) $script:unregisters++ }
function Write-ZswarmJson { param($obj) }
`;
    const body = script.slice(0, main) + mocks + script.slice(main);
    const wrapped = `$script:stops = 0; $script:unregisters = 0; $errorMessage = $null
try { & { ${body} } } catch { $errorMessage = [string]$_.Exception.Message }
@{ stops = $script:stops; unregisters = $script:unregisters; error = $errorMessage } | ConvertTo-Json -Compress
`;
    const output = execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encodePowerShellCommand(wrapped)], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.stops, 0, output);
    assert.equal(result.unregisters, 0, output);
    assert.ok(result.error, "ownership/inspection failure must propagate");
  });
}
