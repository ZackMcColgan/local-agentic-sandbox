/**
 * Checks if a given ISO timestamp falls within the overnight window (default 10pm / 22:00 to 7am / 07:00 local).
 */
export function isWithinOvernightWindow(
  timestampIso: string,
  windowStartHour: number = 22,
  windowEndHour: number = 7
): boolean {
  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) return false;
  const localHour = date.getHours();

  return windowStartHour > windowEndHour
    ? localHour >= windowStartHour || localHour < windowEndHour
    : localHour >= windowStartHour && localHour < windowEndHour;
}
