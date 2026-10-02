export interface Coordinates {
	latitude: number;
	longitude: number;
}

const LOCATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocationServices';
let permissionInstructionsShown = false;

export async function getCoreLocation(): Promise<Coordinates | undefined> {
	if (process.platform !== 'darwin') {
		return undefined;
	}
	const executable = Bun.which('CoreLocationCLI');
	if (!executable) {
		console.error('[CoreLocation] Install the device location helper: brew install --cask corelocationcli');
		return undefined;
	}
	try {
		const child = Bun.spawn([executable, '--format', '{"latitude":%latitude,"longitude":%longitude}'], {
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 12_000,
			killSignal: 'SIGKILL',
		});
		const [output, errors, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) {
			if (/location services are disabled|location access denied|not authorized|permission denied/i.test(`${output}\n${errors}`)) {
				await showPermissionInstructions();
			} else {
				console.error('[CoreLocation] Could not get device location. Make sure Wi-Fi and Location Services are enabled.');
			}
			return undefined;
		}
		const coordinates = parseCoordinates(JSON.parse(output));
		if (!coordinates) {
			console.error('[CoreLocation] The helper returned invalid coordinates.');
		}
		return coordinates;
	} catch {
		console.error('[CoreLocation] Could not run the helper or read its location. Run CoreLocationCLI directly to check its setup.');
		return undefined;
	}
}

async function showPermissionInstructions(): Promise<void> {
	if (permissionInstructionsShown) {
		return;
	}
	permissionInstructionsShown = true;
	console.error('[CoreLocation] Device location needs permission. In System Settings → Privacy & Security → Location Services, enable Location Services and allow CoreLocationCLI. Then rerun your command.');
	try {
		const child = Bun.spawn(['open', LOCATION_SETTINGS_URL], {
			stdout: 'ignore',
			stderr: 'ignore',
			timeout: 5_000,
			killSignal: 'SIGKILL',
		});
		if (await child.exited === 0) {
			return;
		}
	} catch {}
	console.error(`[CoreLocation] Open Location Services manually, or run: open '${LOCATION_SETTINGS_URL}'`);
}

export function parseCoordinates(value: unknown): Coordinates | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { latitude, longitude } = value as { latitude?: unknown; longitude?: unknown };
	if (typeof latitude !== 'number' || typeof longitude !== 'number'
		|| !Number.isFinite(latitude) || !Number.isFinite(longitude)
		|| Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
		return undefined;
	}
	return { latitude, longitude };
}

