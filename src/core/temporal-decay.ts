/**
 * Temporal decay scoring for date-bearing file paths.
 * Files with dates closer to now score higher; undated files are treated as evergreen.
 */
export function temporalDecay(filepath: string, halfLifeDays: number): number {
  const dateMatch = filepath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return 1.0; // evergreen
  const fileDate = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
  const ageInDays = (Date.now() - fileDate.getTime()) / (1000 * 60 * 60 * 24);
  if (ageInDays <= 0) return 1.0;
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageInDays);
}
