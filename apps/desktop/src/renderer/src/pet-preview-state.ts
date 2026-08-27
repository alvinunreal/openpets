export interface PetSpriteLayout {
  readonly version: 1 | 2;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly neutralPose?: {
    readonly row: number;
    readonly column: number;
  };
}

export interface PetSpritePreviewModel {
  readonly atlasColumns: number;
  readonly atlasRows: number;
  readonly row: number;
  readonly frameColumns: readonly number[];
  readonly animated: boolean;
}

export const defaultPetSpriteLayout: PetSpriteLayout = {
  version: 1,
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 9,
};

export function buildPetSpritePreviewModel(
  layout: PetSpriteLayout | undefined,
  state: { readonly row: number; readonly frames: number },
  useNeutralPose = false,
): PetSpritePreviewModel {
  const resolvedLayout = layout ?? defaultPetSpriteLayout;
  const neutralPose = useNeutralPose && state.row === resolvedLayout.neutralPose?.row
    ? resolvedLayout.neutralPose
    : undefined;
  const frameColumns = neutralPose
    ? [neutralPose.column]
    : Array.from({ length: state.frames }, (_, index) => index);

  return {
    atlasColumns: resolvedLayout.columns,
    atlasRows: resolvedLayout.rows,
    row: neutralPose?.row ?? state.row,
    frameColumns,
    animated: !neutralPose && frameColumns.length > 1,
  };
}
