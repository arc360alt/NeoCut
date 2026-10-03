import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks } from "@/timeline";
import { applyRippleAdjustments } from "@/ripple/apply";

/** Moves every element on a track that starts at or after `fromTime`. */
export class ShiftTrackElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly fromTime: number;
	private readonly offset: number;

	constructor({
		trackId,
		fromTime,
		offset,
	}: {
		trackId: string;
		fromTime: number;
		offset: number;
	}) {
		super();
		this.trackId = trackId;
		this.fromTime = fromTime;
		this.offset = offset;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		editor.timeline.updateTracks(
			applyRippleAdjustments({
				tracks: this.savedState,
				adjustments: [
					{
						trackId: this.trackId,
						afterTime: this.fromTime,
						shiftAmount: -this.offset,
					},
				],
			}),
		);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
