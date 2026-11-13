import { Command, createElementSelectionResult, type CommandResult } from "@/commands/base-command";
import { buildCompoundFromSelection } from "@/compound/create";
import { EditorCore } from "@/core";
import type { ElementRef, TScene } from "@/timeline";
import { generateUUID } from "@/utils/id";

/**
 * Turns the selected clips into a compound clip: they move into a new scene
 * and one clip playing that scene takes their place. Undo restores both.
 */
export class CreateCompoundClipCommand extends Command {
	private savedScenes: TScene[] | null = null;
	private readonly selected: readonly ElementRef[];

	constructor({ selected }: { selected: readonly ElementRef[] }) {
		super();
		this.selected = selected;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const active = editor.scenes.getActiveSceneOrNull();
		if (!active) return undefined;

		const scenes = editor.scenes.getScenes();
		const sceneId = generateUUID();
		const name = nextCompoundName({ scenes });
		const result = buildCompoundFromSelection({
			tracks: active.tracks,
			selected: this.selected,
			sceneId,
			name,
		});
		if (!result) return undefined;

		this.savedScenes = [...scenes];
		const now = new Date();
		const compoundScene: TScene = {
			id: sceneId,
			name,
			isMain: false,
			tracks: result.innerTracks,
			bookmarks: [],
			createdAt: now,
			updatedAt: now,
		};
		editor.scenes.setScenes({
			scenes: [
				...scenes.map((scene) =>
					scene.id === active.id
						? { ...scene, tracks: result.outerTracks, updatedAt: now }
						: scene,
				),
				compoundScene,
			],
			activeSceneId: active.id,
		});

		return createElementSelectionResult([
			{ trackId: result.compoundTrackId, elementId: result.compound.id },
		]);
	}

	undo(): void {
		if (!this.savedScenes) return;
		const editor = EditorCore.getInstance();
		editor.scenes.setScenes({ scenes: this.savedScenes });
	}
}

function nextCompoundName({ scenes }: { scenes: readonly TScene[] }): string {
	const used = new Set(scenes.map((scene) => scene.name));
	let index = 1;
	while (used.has(`Compound ${index}`)) index++;
	return `Compound ${index}`;
}
