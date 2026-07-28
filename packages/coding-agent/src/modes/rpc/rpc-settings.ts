import { isRecord } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import {
	getDefault,
	getEnumValues,
	getType,
	getUi,
	isCredential,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	TAB_GROUPS,
	TAB_METADATA,
} from "../../config/settings-schema";
import { getAvailableThemes } from "../theme/theme";

export interface RpcSettingDescriptor {
	path: string;
	type: "boolean" | "string" | "number" | "enum" | "array" | "record";
	value: unknown;
	default: unknown;
	configured: boolean;
	secret: boolean;
	/** Only for paths whose schema default is `undefined`: `set_setting` accepts `null` here to clear the value. */
	nullable: boolean;
	values?: string[];
	ui?: {
		tab: string;
		group?: string;
		label: string;
		description: string;
		condition?: string;
		ordered?: boolean;
		options?: Array<{ value: string; label: string; description?: string }>;
	};
}

export interface RpcSettingsSnapshot {
	tabs: Array<{ id: string; label: string; icon: string; groups: string[] }>;
	settings: RpcSettingDescriptor[];
}

export type RpcSettingValidation =
	| { ok: true; value: unknown }
	| { ok: false; error: string; code: "unknown_setting" | "invalid_value" };

export async function buildRpcSettingsSnapshot(settings: Settings): Promise<RpcSettingsSnapshot> {
	const availableThemes = await getAvailableThemes();
	const descriptors = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(path => {
		const type = getType(path);
		const secret = isCredential(path);
		const ui = getUi(path);
		const runtimeOptions =
			ui?.options === "runtime" && (path === "theme.dark" || path === "theme.light")
				? availableThemes.map(name => ({ value: name, label: name }))
				: undefined;

		return {
			path,
			type,
			value: secret ? null : (settings.get(path) ?? null),
			default: getDefault(path) ?? null,
			configured: settings.isConfigured(path),
			secret,
			nullable: getDefault(path) === undefined,
			...(type === "enum" ? { values: [...(getEnumValues(path) ?? [])] } : {}),
			...(ui
				? {
						ui: {
							tab: ui.tab,
							group: ui.group,
							label: ui.label,
							description: ui.description,
							condition: ui.condition,
							ordered: ui.ordered,
							...(ui.options === "runtime"
								? runtimeOptions
									? { options: runtimeOptions }
									: {}
								: ui.options
									? { options: ui.options.map(option => ({ ...option })) }
									: {}),
						},
					}
				: {}),
		};
	});

	return {
		tabs: SETTING_TABS.map(id => ({
			id,
			label: TAB_METADATA[id].label,
			icon: TAB_METADATA[id].icon,
			groups: [...TAB_GROUPS[id]],
		})),
		settings: descriptors,
	};
}

export function validateRpcSettingValue(path: string, value: unknown): RpcSettingValidation {
	if (!Object.hasOwn(SETTINGS_SCHEMA, path)) {
		return { ok: false, code: "unknown_setting", error: `Unknown setting: ${path}` };
	}

	const settingPath = path as SettingPath;
	const type = getType(settingPath);

	// Paths whose schema default is `undefined` have no representable default on the
	// wire (`JSON.stringify` drops `undefined`), so the snapshot reports them as
	// `value: null, nullable: true`. Accept that same `null` back as "clear it",
	// otherwise a client could read a setting it is unable to write back.
	if (value === null && getDefault(settingPath) === undefined) {
		return { ok: true, value: undefined };
	}
	let valid: boolean;

	switch (type) {
		case "boolean":
			valid = typeof value === "boolean";
			break;
		case "number":
			valid = typeof value === "number" && Number.isFinite(value);
			break;
		case "string":
			valid = typeof value === "string";
			break;
		case "enum":
			valid = typeof value === "string" && getEnumValues(settingPath)?.includes(value) === true;
			break;
		case "array":
			valid = Array.isArray(value);
			break;
		case "record":
			// Settings loads config values as unknown, so arrays and records share its container-level trust.
			valid = isRecord(value);
			break;
	}

	return valid ? { ok: true, value } : { ok: false, code: "invalid_value", error: `Setting ${path} expects ${type}` };
}
