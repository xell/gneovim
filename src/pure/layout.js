export function screenMetrics(
  availableWidth,
  availableHeight,
  cellWidth,
  cellHeight,
  minimumHorizontalPadding = 4,
) {
  const cols = Math.max(
    20,
    Math.floor((availableWidth - 2 * minimumHorizontalPadding) / cellWidth),
  );
  const rows = Math.max(4, Math.floor(availableHeight / cellHeight));
  const padX = Math.max(
    minimumHorizontalPadding,
    Math.round((availableWidth - cols * cellWidth) / 2),
  );
  return { cols, rows, padX };
}
