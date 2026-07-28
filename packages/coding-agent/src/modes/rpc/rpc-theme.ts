import { getColorBlindMode, getCurrentThemeName, getResolvedThemeColors, SYMBOL_KEYS, theme } from "../theme/theme";

export interface RpcThemeSnapshot {
	name: string;
	isLight: boolean;
	colorMode: string;
	symbolPreset: string;
	colorBlindMode: boolean;
	/** Every semantic color token -> hex, or null where the theme defers to the terminal default. */
	colors: Record<string, string | null>;
	/** Every symbol key -> the glyph resolved under the active preset and overrides. */
	symbols: Record<string, string>;
	/** Luminance hints the status line uses for contrast decisions. */
	statusLineLuminance: number;
	accentSurfaceLuminance: number;
}

export async function buildRpcThemeSnapshot(): Promise<RpcThemeSnapshot> {
	const name = getCurrentThemeName();
	if (!name || typeof theme === "undefined") throw new Error("Theme is not initialized");

	const colors = await getResolvedThemeColors(name, {
		preserveTerminalDefault: true,
		activeTheme: theme,
	});
	const symbols: Record<string, string> = {};
	for (const key of SYMBOL_KEYS) symbols[key] = theme.symbol(key);

	return {
		name,
		isLight: theme.isLight,
		colorMode: theme.getColorMode(),
		symbolPreset: theme.getSymbolPreset(),
		colorBlindMode: getColorBlindMode(),
		colors,
		symbols,
		statusLineLuminance: theme.statusLineLuminance ?? 0,
		accentSurfaceLuminance: theme.accentSurfaceLuminance ?? 0,
	};
}
