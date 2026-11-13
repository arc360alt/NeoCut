import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { stylizeEffectDefinitions } from "./stylize";

const defaultEffects = [blurEffectDefinition, ...stylizeEffectDefinitions];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
