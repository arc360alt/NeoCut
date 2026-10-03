import { transitionsRegistry } from "../registry";
import {
	blurTransitionDefinition,
	dipTransitionDefinition,
	fadeTransitionDefinition,
} from "./dissolve";
import {
	pushTransitionDefinition,
	slideTransitionDefinition,
	spinTransitionDefinition,
	zoomTransitionDefinition,
} from "./motion";
import {
	clockWipeTransitionDefinition,
	irisTransitionDefinition,
	splitTransitionDefinition,
	wipeTransitionDefinition,
} from "./reveal";
import {
	cubeTransitionDefinition,
	flipTransitionDefinition,
} from "./three-d";

const defaultTransitionDefinitions = [
	fadeTransitionDefinition,
	dipTransitionDefinition,
	slideTransitionDefinition,
	pushTransitionDefinition,
	wipeTransitionDefinition,
	splitTransitionDefinition,
	irisTransitionDefinition,
	clockWipeTransitionDefinition,
	zoomTransitionDefinition,
	spinTransitionDefinition,
	blurTransitionDefinition,
	cubeTransitionDefinition,
	flipTransitionDefinition,
];

export function registerDefaultTransitions(): void {
	for (const definition of defaultTransitionDefinitions) {
		if (transitionsRegistry.has(definition.type)) {
			continue;
		}
		transitionsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
