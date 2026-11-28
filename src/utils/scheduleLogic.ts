import { Course } from '../data/database';
import {
  ACADEMIC_CONFIG,
  parseIsoDateToUtcMidnightMs,
} from '../config/academicConfig';

export const ONLINE_GRADE_10_SCHEDULE_SCOPE = 'online_10' as const;

export type ScheduleScope = typeof ONLINE_GRADE_10_SCHEDULE_SCOPE;

/**
 * Daily 1-hour slots starting at 10:00 and ending at 22:00:
 * 10-11, 11-12, ..., 21-22 (12 slots total).
 */
export const SCHEDULE_HOURS: readonly number[] = [
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
];

export interface ScheduleDayMeta {
  dayIndex: number; // 0 = Monday .. 6 = Sunday
  name: string;
  shortName: string;
}

export const SCHEDULE_DAYS: readonly ScheduleDayMeta[] = [
  { dayIndex: 0, name: 'pazartesi', shortName: 'pzt' },
  { dayIndex: 1, name: 'salı', shortName: 'sal' },
  { dayIndex: 2, name: 'çarşamba', shortName: 'çar' },
  { dayIndex: 3, name: 'perşembe', shortName: 'per' },
  { dayIndex: 4, name: 'cuma', shortName: 'cum' },
  { dayIndex: 5, name: 'cumartesi', shortName: 'cmt' },
  { dayIndex: 6, name: 'pazar', shortName: 'paz' },
];

export interface WeeklyScheduleSlot {
  id: string;
  scope: ScheduleScope;
  weekNumber: number;
  dayIndex: number;
  startHour: number;
  courseId: string;
  subject: string;
  instructorId: string;
  instructorName: string;
  updatedAt: string;
}

export interface WeekDayWithDate extends ScheduleDayMeta {
  dayOfMonth: number;
  shortDateLabel: string; // e.g., "23 kas"
  fullDateLabel: string; // e.g., "23 kasım pazartesi"
}

const TURKISH_MONTHS_FULL = [
  'ocak',
  'şubat',
  'mart',
  'nisan',
  'mayıs',
  'haziran',
  'temmuz',
  'ağustos',
  'eylül',
  'ekim',
  'kasım',
  'aralık',
];

const TURKISH_MONTHS_SHORT = [
  'oca',
  'şub',
  'mar',
  'nis',
  'may',
  'haz',
  'tem',
  'ağu',
  'eyl',
  'eki',
  'kas',
  'ara',
];

/**
 * Returns true ONLY for 10th-grade online ("çevrim içi") courses.
 * Uses strict prefix matching (^10($|[^0-9])) so 10/a, 10/b, "10. sınıf" match
 * while 9/a, 11/a, 100/a, or any yüz yüze course return false.
 */
export function isOnlineGrade10Course(
  course: Pick<Course, 'modality' | 'gradeClass'> | null | undefined
): boolean {
  if (!course || course.modality !== 'online') return false;
  const normalizedGrade = (course.gradeClass || '').trim().toLowerCase();
  return /^10($|[^0-9])/.test(normalizedGrade);
}

/**
 * Formats an hour slot as "10-11", "11-12", ..., "21-22".
 */
export function formatHourSlotRange(startHour: number): string {
  return `${startHour}-${startHour + 1}`;
}

/**
 * Builds deterministic Firestore document ID for a single schedule slot.
 * Always matches ^[a-zA-Z0-9_\-]+$.
 */
export function buildScheduleSlotDocId(
  scope: ScheduleScope,
  weekNumber: number,
  dayIndex: number,
  startHour: number
): string {
  const safeWeek = Math.max(1, Math.min(52, Math.floor(weekNumber)))
    .toString()
    .padStart(2, '0');
  const safeDay = Math.max(0, Math.min(6, Math.floor(dayIndex)));
  const safeHour = Math.max(10, Math.min(21, Math.floor(startHour)));
  return `${scope}_w${safeWeek}_d${safeDay}_h${safeHour}`;
}

/**
 * Returns the 7 days of an academic week (Monday..Sunday) with exact Turkish dates.
 */
export function getWeekDaysWithDates(
  weekNumber: number,
  termStartIso: string = ACADEMIC_CONFIG.termStartMondayIso
): WeekDayWithDate[] {
  const anchorUtcMs = parseIsoDateToUtcMidnightMs(termStartIso);
  const weekMondayMs = anchorUtcMs + (weekNumber - 1) * 7 * 24 * 60 * 60 * 1000;

  return SCHEDULE_DAYS.map(day => {
    const dt = new Date(weekMondayMs + day.dayIndex * 24 * 60 * 60 * 1000);
    const dayOfMonth = dt.getUTCDate();
    const monthIndex = dt.getUTCMonth();
    return {
      ...day,
      dayOfMonth,
      shortDateLabel: `${dayOfMonth} ${TURKISH_MONTHS_SHORT[monthIndex]}`,
      fullDateLabel: `${dayOfMonth} ${TURKISH_MONTHS_FULL[monthIndex]} ${day.name}`,
    };
  });
}

export type SlotToggleDecision =
  | { action: 'claim' }
  | { action: 'unclaim' }
  | { action: 'occupied_by_other'; ownerName: string; subject: string };

/**
 * Pure decision function for clicking a schedule cell:
 * - Empty slot -> claim
 * - Own slot (same instructorId) -> unclaim
 * - Another instructor's slot -> occupied_by_other (do not overwrite)
 */
export function resolveSlotToggleAction(
  existingSlot: WeeklyScheduleSlot | undefined | null,
  currentInstructorId: string
): SlotToggleDecision {
  if (!existingSlot) {
    return { action: 'claim' };
  }
  if (existingSlot.instructorId === currentInstructorId) {
    return { action: 'unclaim' };
  }
  return {
    action: 'occupied_by_other',
    ownerName: existingSlot.instructorName,
    subject: existingSlot.subject,
  };
}

/**
 * Pure optimistic update helper for slot arrays so clicking feels instantaneous.
 */
export function applyOptimisticSlotChange(
  slots: WeeklyScheduleSlot[],
  change:
    | { type: 'claim'; slot: WeeklyScheduleSlot }
    | { type: 'unclaim'; slotId: string }
): WeeklyScheduleSlot[] {
  if (change.type === 'unclaim') {
    return slots.filter(s => s.id !== change.slotId);
  }
  const filtered = slots.filter(s => s.id !== change.slot.id);
  return [...filtered, change.slot];
}

/**
 * Short display label for a subject so schedule cells stay crisp and readable.
 */
export function getShortSubjectLabel(subject: string): string {
  const s = (subject || '').trim().toLowerCase();
  if (s === 'türk dili ve edebiyatı') return 'edebiyat';
  return s;
}

export interface SubjectColorTheme {
  bg: string;
  border: string;
  text: string;
  subtext: string;
  dot: string;
}

/**
 * Muted editorial subject tints for OTHER instructors' slots
 * (logged-in instructor's own slots use bold charcoal stone-900 for instant distinction).
 */
export function getOtherSubjectTheme(subject: string): SubjectColorTheme {
  const s = (subject || '').trim().toLowerCase();
  if (s.includes('mat')) {
    return {
      bg: 'bg-sky-50/95',
      border: 'border-sky-300/90',
      text: 'text-sky-950',
      subtext: 'text-sky-800/85',
      dot: 'bg-sky-600',
    };
  }
  if (s.includes('fiz')) {
    return {
      bg: 'bg-indigo-50/95',
      border: 'border-indigo-300/90',
      text: 'text-indigo-950',
      subtext: 'text-indigo-800/85',
      dot: 'bg-indigo-600',
    };
  }
  if (s.includes('kim')) {
    return {
      bg: 'bg-amber-50/95',
      border: 'border-amber-300/90',
      text: 'text-amber-950',
      subtext: 'text-amber-800/85',
      dot: 'bg-amber-600',
    };
  }
  if (s.includes('biy')) {
    return {
      bg: 'bg-emerald-50/95',
      border: 'border-emerald-300/90',
      text: 'text-emerald-950',
      subtext: 'text-emerald-800/85',
      dot: 'bg-emerald-600',
    };
  }
  if (s.includes('edeb') || s.includes('türk')) {
    return {
      bg: 'bg-rose-50/95',
      border: 'border-rose-300/90',
      text: 'text-rose-950',
      subtext: 'text-rose-800/85',
      dot: 'bg-rose-600',
    };
  }
  if (s.includes('ing')) {
    return {
      bg: 'bg-violet-50/95',
      border: 'border-violet-300/90',
      text: 'text-violet-950',
      subtext: 'text-violet-800/85',
      dot: 'bg-violet-600',
    };
  }
  return {
    bg: 'bg-stone-100/95',
    border: 'border-stone-300',
    text: 'text-stone-900',
    subtext: 'text-stone-600',
    dot: 'bg-stone-500',
  };
}
