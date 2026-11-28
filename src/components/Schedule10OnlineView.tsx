import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { CalendarDays, Check, Clock, Lock, X } from 'lucide-react';
import { Course, Instructor } from '../data/database';
import {
  db,
  formatFirestoreTimestamp,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import {
  ACADEMIC_CONFIG,
  getTrustedNow,
  getZonedDateParts,
  parseIsoDateToUtcMidnightMs,
} from '../config/academicConfig';
import { getWeekDateRangeLabel } from '../utils/enigmaLogic';
import {
  applyOptimisticSlotChange,
  buildScheduleSlotDocId,
  formatHourSlotRange,
  getOtherSubjectTheme,
  getShortSubjectLabel,
  getWeekDaysWithDates,
  ONLINE_GRADE_10_SCHEDULE_SCOPE,
  resolveSlotToggleAction,
  SCHEDULE_HOURS,
  WeeklyScheduleSlot,
} from '../utils/scheduleLogic';

interface Schedule10OnlineViewProps {
  instructor: Instructor;
  course: Course;
  selectedWeek: number;
}

class SlotConflictError extends Error {
  ownerName: string;
  subject: string;
  constructor(ownerName: string, subject: string) {
    super('SLOT_CONFLICT');
    this.ownerName = ownerName;
    this.subject = subject;
  }
}

function getTodayDayIndexIfInWeek(weekNumber: number): number | null {
  const { year, month, day } = getZonedDateParts(
    getTrustedNow(),
    ACADEMIC_CONFIG.timeZone
  );
  const todayUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const anchorUtcMs = parseIsoDateToUtcMidnightMs(
    ACADEMIC_CONFIG.termStartMondayIso
  );
  const weekStartMs = anchorUtcMs + (weekNumber - 1) * 7 * 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((todayUtcMs - weekStartMs) / (1000 * 60 * 60 * 24));
  if (diffDays >= 0 && diffDays <= 6) {
    return diffDays;
  }
  return null;
}

export const Schedule10OnlineView: React.FC<Schedule10OnlineViewProps> = ({
  instructor,
  course,
  selectedWeek,
}) => {
  const [slots, setSlots] = useState<WeeklyScheduleSlot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busySlotIds, setBusySlotIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<{
    type: 'info' | 'error';
    text: string;
  } | null>(null);

  const todayDayIndex = useMemo(
    () => getTodayDayIndexIfInWeek(selectedWeek),
    [selectedWeek]
  );

  const [mobileDayIndex, setMobileDayIndex] = useState<number>(
    () => getTodayDayIndexIfInWeek(selectedWeek) ?? 0
  );

  useEffect(() => {
    setMobileDayIndex(todayDayIndex ?? 0);
  }, [selectedWeek, todayDayIndex]);

  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (type: 'info' | 'error', text: string) => {
    setNotice({ type, text });
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = setTimeout(() => {
      setNotice(null);
    }, 4000);
  };

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  // Scoped Firestore subscription: active ONLY while this schedule view is mounted
  useEffect(() => {
    setIsLoading(true);
    const scheduleQuery = query(
      collection(db, 'weekly_schedules'),
      where('scope', '==', ONLINE_GRADE_10_SCHEDULE_SCOPE),
      where('weekNumber', '==', selectedWeek)
    );

    const docMap = new Map<string, WeeklyScheduleSlot>();
    let initialized = false;

    const unsub = onSnapshot(
      scheduleQuery,
      snapshot => {
        const changes = snapshot.docChanges();
        if (initialized && changes.length === 0) {
          return;
        }

        if (!initialized) {
          docMap.clear();
          snapshot.forEach(docSnap => {
            const raw = docSnap.data();
            docMap.set(docSnap.id, {
              id: docSnap.id,
              scope: ONLINE_GRADE_10_SCHEDULE_SCOPE,
              weekNumber: Number(raw.weekNumber),
              dayIndex: Number(raw.dayIndex),
              startHour: Number(raw.startHour),
              courseId: String(raw.courseId || ''),
              subject: String(raw.subject || ''),
              instructorId: String(raw.instructorId || ''),
              instructorName: String(raw.instructorName || ''),
              updatedAt: formatFirestoreTimestamp(
                raw.updatedAt,
                raw.updatedAtIso
              ),
            });
          });
          initialized = true;
        } else {
          for (const change of changes) {
            if (change.type === 'removed') {
              docMap.delete(change.doc.id);
            } else {
              const raw = change.doc.data();
              docMap.set(change.doc.id, {
                id: change.doc.id,
                scope: ONLINE_GRADE_10_SCHEDULE_SCOPE,
                weekNumber: Number(raw.weekNumber),
                dayIndex: Number(raw.dayIndex),
                startHour: Number(raw.startHour),
                courseId: String(raw.courseId || ''),
                subject: String(raw.subject || ''),
                instructorId: String(raw.instructorId || ''),
                instructorName: String(raw.instructorName || ''),
                updatedAt: formatFirestoreTimestamp(
                  raw.updatedAt,
                  raw.updatedAtIso
                ),
              });
            }
          }
        }

        setSlots(Array.from(docMap.values()));
        setIsLoading(false);
      },
      error => {
        console.error('Ders programı dinleme hatası:', error);
        setIsLoading(false);
        showNotice(
          'error',
          'ders programı yüklenirken bir bağlantı sorunu oluştu. lütfen tekrar dene.'
        );
      }
    );

    return () => {
      unsub();
    };
  }, [selectedWeek]);

  const weekDays = useMemo(
    () => getWeekDaysWithDates(selectedWeek),
    [selectedWeek]
  );

  const slotByKey = useMemo(() => {
    const map = new Map<string, WeeklyScheduleSlot>();
    for (const s of slots) {
      map.set(`${s.dayIndex}_${s.startHour}`, s);
    }
    return map;
  }, [slots]);

  const mySlotsCount = useMemo(
    () => slots.filter(s => s.instructorId === instructor.id).length,
    [slots, instructor.id]
  );

  const daySlotCounts = useMemo(() => {
    const counts = new Array<number>(7).fill(0);
    for (const s of slots) {
      if (s.dayIndex >= 0 && s.dayIndex < 7) {
        counts[s.dayIndex] += 1;
      }
    }
    return counts;
  }, [slots]);

  const handleSlotClick = async (dayIndex: number, startHour: number) => {
    const slotId = buildScheduleSlotDocId(
      ONLINE_GRADE_10_SCHEDULE_SCOPE,
      selectedWeek,
      dayIndex,
      startHour
    );

    if (busySlotIds.has(slotId)) {
      return;
    }

    const existing = slotByKey.get(`${dayIndex}_${startHour}`);
    const decision = resolveSlotToggleAction(existing, instructor.id);

    if (decision.action === 'occupied_by_other') {
      showNotice(
        'info',
        `bu saat ${decision.ownerName} (${decision.subject}) tarafından alınmış.`
      );
      return;
    }

    const prevSlots = slots;
    const nowIso = new Date().toISOString();

    setBusySlotIds(prev => {
      const next = new Set(prev);
      next.add(slotId);
      return next;
    });

    if (decision.action === 'claim') {
      const newSlot: WeeklyScheduleSlot = {
        id: slotId,
        scope: ONLINE_GRADE_10_SCHEDULE_SCOPE,
        weekNumber: selectedWeek,
        dayIndex,
        startHour,
        courseId: course.id,
        subject: course.subject,
        instructorId: instructor.id,
        instructorName: instructor.name,
        updatedAt: nowIso,
      };
      setSlots(curr =>
        applyOptimisticSlotChange(curr, { type: 'claim', slot: newSlot })
      );

      const docRef = doc(db, 'weekly_schedules', slotId);
      const payload = {
        scope: ONLINE_GRADE_10_SCHEDULE_SCOPE,
        weekNumber: selectedWeek,
        dayIndex,
        startHour,
        courseId: course.id.slice(0, 100),
        subject: course.subject.slice(0, 80),
        instructorId: instructor.id.slice(0, 100),
        instructorName: instructor.name.slice(0, 120),
        updatedAt: serverTimestamp(),
        updatedAtIso: nowIso,
      };

      try {
        const isOnline =
          typeof navigator !== 'undefined' ? navigator.onLine : true;
        if (isOnline) {
          await runTransaction(db, async tx => {
            const snap = await tx.get(docRef);
            if (snap.exists()) {
              const data = snap.data();
              if (data.instructorId && data.instructorId !== instructor.id) {
                throw new SlotConflictError(
                  String(data.instructorName || 'başka bir eğitmen'),
                  String(data.subject || 'ders')
                );
              }
            }
            tx.set(docRef, payload);
          });
        } else {
          await setDoc(docRef, payload);
        }
      } catch (err) {
        setSlots(prevSlots);
        if (err instanceof SlotConflictError) {
          showNotice(
            'info',
            `bu saat az önce ${err.ownerName} (${err.subject}) tarafından alındı.`
          );
        } else {
          showNotice(
            'error',
            'saat kaydedilemedi. lütfen internet bağlantını kontrol edip tekrar dene.'
          );
          try {
            handleFirestoreError(
              err,
              OperationType.WRITE,
              `weekly_schedules/${slotId}`
            );
          } catch {
            // logged via handleFirestoreError
          }
        }
      } finally {
        setBusySlotIds(prev => {
          const next = new Set(prev);
          next.delete(slotId);
          return next;
        });
      }
      return;
    }

    // decision.action === 'unclaim'
    setSlots(curr =>
      applyOptimisticSlotChange(curr, { type: 'unclaim', slotId })
    );
    const docRef = doc(db, 'weekly_schedules', slotId);

    try {
      const isOnline =
        typeof navigator !== 'undefined' ? navigator.onLine : true;
      if (isOnline) {
        await runTransaction(db, async tx => {
          const snap = await tx.get(docRef);
          if (!snap.exists()) return;
          const data = snap.data();
          if (data.instructorId && data.instructorId !== instructor.id) {
            throw new SlotConflictError(
              String(data.instructorName || 'başka bir eğitmen'),
              String(data.subject || 'ders')
            );
          }
          tx.delete(docRef);
        });
      } else {
        await deleteDoc(docRef);
      }
    } catch (err) {
      setSlots(prevSlots);
      if (err instanceof SlotConflictError) {
        showNotice(
          'info',
          `bu saat ${err.ownerName} (${err.subject}) adına kayıtlı olduğu için kaldırılamadı.`
        );
      } else {
        showNotice(
          'error',
          'iptal işlemi kaydedilemedi. lütfen tekrar dene.'
        );
        try {
          handleFirestoreError(
            err,
            OperationType.DELETE,
            `weekly_schedules/${slotId}`
          );
        } catch {
          // logged via handleFirestoreError
        }
      }
    } finally {
      setBusySlotIds(prev => {
        const next = new Set(prev);
        next.delete(slotId);
        return next;
      });
    }
  };

  const activeMobileDay = weekDays[mobileDayIndex] || weekDays[0];

  return (
    <section
      data-testid="schedule-10-online-view"
      aria-label="10. sınıf çevrim içi haftalık ders programı"
      className="space-y-4 sm:space-y-5"
    >
      {/* Schedule Subheader Card */}
      <div className="rounded-2xl border border-stone-300/80 bg-white/90 px-4 py-3.5 sm:px-5 sm:py-4 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <CalendarDays className="h-4 w-4 sm:h-5 sm:w-5 text-stone-800 shrink-0" />
              <h2 className="font-serif-art text-xl sm:text-2xl text-stone-900 leading-tight">
                10. sınıf ders programı
              </h2>
              <span className="text-xs font-mono-num text-stone-500">
                · {selectedWeek}. hafta ({getWeekDateRangeLabel(selectedWeek)})
              </span>
            </div>
            <p className="text-xs text-stone-600 leading-relaxed">
              boş bir saat kutusuna dokunarak{' '}
              <strong className="font-medium text-stone-900">
                {course.subject}
              </strong>{' '}
              dersini kendine ayırabilir, kendi kutuna tekrar dokunarak iptal edebilirsin.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto shrink-0 rounded-xl border border-stone-200 bg-[#faf8f4] px-3 py-1.5 text-xs font-mono-num text-stone-700">
            <span>senin: {mySlotsCount} saat</span>
            <span aria-hidden="true" className="text-stone-400">
              ·
            </span>
            <span>toplam: {slots.length} saat</span>
          </div>
        </div>

        {/* Compact Legend */}
        <div className="mt-3 pt-2.5 border-t border-stone-200/70 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-stone-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded border border-stone-900 bg-stone-900 inline-block" />
            <span>senin dersin (iptal için tekrar dokun)</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded border border-sky-300 bg-sky-50 inline-block" />
            <span>diğer 10. sınıf eğitmenleri</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded border border-stone-300 bg-white inline-block" />
            <span>boş saat (ayırmak için dokun)</span>
          </span>
        </div>
      </div>

      {/* Inline Feedback Notice */}
      {notice && (
        <div
          role={notice.type === 'error' ? 'alert' : 'status'}
          data-testid="schedule-notice"
          className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-xs ${
            notice.type === 'error'
              ? 'border-rose-300 bg-rose-50/95 text-rose-900'
              : 'border-amber-300 bg-amber-50/95 text-amber-950'
          }`}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="bildirimi kapat"
            className="text-current opacity-65 hover:opacity-100 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Loading Indicator */}
      {isLoading ? (
        <div className="rounded-2xl border border-stone-300/80 bg-white/80 py-14 text-center text-xs text-stone-500">
          ders programı yükleniyor...
        </div>
      ) : (
        <>
          {/* DESKTOP VIEW: Full 7-Day x 12-Hour Weekly Grid */}
          <div className="hidden md:block rounded-2xl border border-stone-300/85 bg-[#faf8f4]/95 p-3 lg:p-4 shadow-2xs overflow-x-auto">
            <div className="min-w-[700px]">
              {/* Day Column Headers */}
              <div className="grid grid-cols-[72px_repeat(7,minmax(0,1fr))] gap-1.5 pb-2 border-b border-stone-200/90">
                <div className="flex items-center justify-center gap-1 text-[11px] font-medium text-stone-500">
                  <Clock className="h-3 w-3" />
                  <span>saat</span>
                </div>
                {weekDays.map(day => {
                  const isToday = todayDayIndex === day.dayIndex;
                  return (
                    <div
                      key={day.dayIndex}
                      className={`rounded-xl px-2 py-1.5 text-center ${
                        isToday
                          ? 'bg-stone-900 text-stone-100'
                          : 'bg-white/75 text-stone-800 border border-stone-200/70'
                      }`}
                    >
                      <div className="text-xs font-medium leading-tight">
                        {day.name}
                      </div>
                      <div
                        className={`text-[10px] font-mono-num mt-0.5 ${
                          isToday ? 'text-stone-300' : 'text-stone-500'
                        }`}
                      >
                        {day.shortDateLabel}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 12 Hourly Rows (10-11 .. 21-22) */}
              <div className="divide-y divide-stone-200/55">
                {SCHEDULE_HOURS.map(hour => {
                  const rangeLabel = formatHourSlotRange(hour);
                  return (
                    <div
                      key={hour}
                      className="grid grid-cols-[72px_repeat(7,minmax(0,1fr))] gap-1.5 py-1.5 items-stretch"
                    >
                      <div className="flex items-center justify-center font-mono-num text-xs font-medium text-stone-600 select-none">
                        {rangeLabel}
                      </div>

                      {weekDays.map(day => {
                        const slot = slotByKey.get(`${day.dayIndex}_${hour}`);
                        const slotId = buildScheduleSlotDocId(
                          ONLINE_GRADE_10_SCHEDULE_SCOPE,
                          selectedWeek,
                          day.dayIndex,
                          hour
                        );
                        const isMine = slot?.instructorId === instructor.id;
                        const isOther = Boolean(slot && !isMine);
                        const isBusy = busySlotIds.has(slotId);
                        const otherTheme = isOther && slot
                          ? getOtherSubjectTheme(slot.subject)
                          : null;

                        const ariaLabel = isMine && slot
                          ? `${day.name} ${rangeLabel} ${slot.subject} (${slot.instructorName}) — senin dersin, iptal etmek için dokun`
                          : isOther && slot
                          ? `${day.name} ${rangeLabel} ${slot.subject} (${slot.instructorName}) — başka eğitmen tarafından alınmış`
                          : `${day.name} ${rangeLabel} boş — kendine ayırmak için dokun`;

                        return (
                          <button
                            key={slotId}
                            type="button"
                            data-testid={`slot-d${day.dayIndex}-h${hour}`}
                            data-slot-state={
                              isMine ? 'mine' : isOther ? 'other' : 'empty'
                            }
                            aria-label={ariaLabel}
                            aria-pressed={isMine}
                            disabled={isBusy}
                            onClick={() =>
                              void handleSlotClick(day.dayIndex, hour)
                            }
                            className={`group relative min-h-[50px] rounded-xl border px-2 py-1.5 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-700 ${
                              isMine
                                ? 'border-stone-900 bg-stone-900 text-stone-100 hover:bg-stone-800 shadow-xs cursor-pointer active:scale-[0.98]'
                                : isOther && otherTheme
                                ? `${otherTheme.border} ${otherTheme.bg} ${otherTheme.text} cursor-not-allowed`
                                : 'border-stone-200/90 bg-white/85 text-stone-500 hover:border-stone-500 hover:bg-white hover:text-stone-800 cursor-pointer active:scale-[0.98]'
                            } ${isBusy ? 'opacity-70' : ''}`}
                          >
                            {isMine && slot ? (
                              <div className="flex flex-col justify-between h-full">
                                <div className="flex items-start justify-between gap-1">
                                  <span className="text-[11px] font-semibold leading-tight truncate">
                                    {getShortSubjectLabel(slot.subject)}
                                  </span>
                                  <Check className="h-3 w-3 shrink-0 text-emerald-300 group-hover:hidden" />
                                  <X className="h-3 w-3 shrink-0 text-rose-300 hidden group-hover:block" />
                                </div>
                                <span className="text-[10px] text-stone-300 truncate mt-0.5">
                                  <span className="group-hover:hidden">
                                    {slot.instructorName}
                                  </span>
                                  <span className="hidden group-hover:inline text-rose-200">
                                    iptal et
                                  </span>
                                </span>
                              </div>
                            ) : isOther && slot && otherTheme ? (
                              <div className="flex flex-col justify-between h-full">
                                <div className="flex items-start justify-between gap-1">
                                  <span className="text-[11px] font-semibold leading-tight truncate">
                                    {getShortSubjectLabel(slot.subject)}
                                  </span>
                                  <Lock className="h-2.5 w-2.5 shrink-0 opacity-50 mt-0.5" />
                                </div>
                                <span
                                  className={`text-[10px] truncate mt-0.5 ${otherTheme.subtext}`}
                                >
                                  {slot.instructorName}
                                </span>
                              </div>
                            ) : (
                              <div className="flex h-full items-center justify-center">
                                <span className="text-[10px] text-stone-400 opacity-0 group-hover:opacity-100 transition-opacity">
                                  + ayır
                                </span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* MOBILE VIEW: 7-Day Selector + Full-Width Hourly Slot List */}
          <div className="md:hidden space-y-3">
            {/* Day Picker Tabs */}
            <div
              role="tablist"
              aria-label="haftanın günleri"
              className="grid grid-cols-7 gap-1 rounded-2xl border border-stone-300/80 bg-[#faf8f4]/95 p-1.5"
            >
              {weekDays.map(day => {
                const isSelected = mobileDayIndex === day.dayIndex;
                const count = daySlotCounts[day.dayIndex] || 0;
                return (
                  <button
                    key={day.dayIndex}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    aria-label={`${day.fullDateLabel}, ${count} ders`}
                    onClick={() => setMobileDayIndex(day.dayIndex)}
                    className={`flex flex-col items-center justify-center rounded-xl py-2 px-1 transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-stone-900 text-stone-100 shadow-xs'
                        : 'bg-white/80 text-stone-700 hover:bg-white'
                    }`}
                  >
                    <span className="text-[10px] font-medium leading-none">
                      {day.shortName}
                    </span>
                    <span
                      className={`font-mono-num text-xs mt-1 leading-none ${
                        isSelected ? 'text-stone-200' : 'text-stone-500'
                      }`}
                    >
                      {day.dayOfMonth}
                    </span>
                    <span
                      className={`mt-1 h-1.5 w-1.5 rounded-full ${
                        count > 0
                          ? isSelected
                            ? 'bg-emerald-300'
                            : 'bg-stone-700'
                          : 'bg-transparent'
                      }`}
                    />
                  </button>
                );
              })}
            </div>

            {/* Selected Day Slots */}
            <div className="rounded-2xl border border-stone-300/80 bg-white/90 p-3 space-y-2">
              <div className="flex items-center justify-between border-b border-stone-200/80 pb-2 px-1">
                <span className="font-serif-art text-lg font-medium text-stone-900">
                  {activeMobileDay.fullDateLabel}
                </span>
                <span className="text-[11px] font-mono-num text-stone-500">
                  {daySlotCounts[activeMobileDay.dayIndex] || 0} ders
                </span>
              </div>

              <div className="space-y-1.5">
                {SCHEDULE_HOURS.map(hour => {
                  const rangeLabel = formatHourSlotRange(hour);
                  const slot = slotByKey.get(
                    `${activeMobileDay.dayIndex}_${hour}`
                  );
                  const slotId = buildScheduleSlotDocId(
                    ONLINE_GRADE_10_SCHEDULE_SCOPE,
                    selectedWeek,
                    activeMobileDay.dayIndex,
                    hour
                  );
                  const isMine = slot?.instructorId === instructor.id;
                  const isOther = Boolean(slot && !isMine);
                  const isBusy = busySlotIds.has(slotId);
                  const otherTheme = isOther && slot
                    ? getOtherSubjectTheme(slot.subject)
                    : null;

                  const ariaLabel = isMine && slot
                    ? `${activeMobileDay.name} ${rangeLabel} ${slot.subject} (${slot.instructorName}) — senin dersin, iptal etmek için dokun`
                    : isOther && slot
                    ? `${activeMobileDay.name} ${rangeLabel} ${slot.subject} (${slot.instructorName}) — başka eğitmen tarafından alınmış`
                    : `${activeMobileDay.name} ${rangeLabel} boş — kendine ayırmak için dokun`;

                  return (
                    <button
                      key={slotId}
                      type="button"
                      data-testid={`mobile-slot-d${activeMobileDay.dayIndex}-h${hour}`}
                      data-slot-state={
                        isMine ? 'mine' : isOther ? 'other' : 'empty'
                      }
                      aria-label={ariaLabel}
                      aria-pressed={isMine}
                      disabled={isBusy}
                      onClick={() =>
                        void handleSlotClick(activeMobileDay.dayIndex, hour)
                      }
                      className={`w-full flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-all ${
                        isMine
                          ? 'border-stone-900 bg-stone-900 text-stone-100 shadow-xs cursor-pointer active:scale-[0.99]'
                          : isOther && otherTheme
                          ? `${otherTheme.border} ${otherTheme.bg} ${otherTheme.text} cursor-not-allowed`
                          : 'border-stone-200/90 bg-[#faf8f4]/70 text-stone-700 hover:border-stone-400 hover:bg-white cursor-pointer active:scale-[0.99]'
                      } ${isBusy ? 'opacity-70' : ''}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`font-mono-num text-xs font-medium px-2 py-1 rounded-lg shrink-0 ${
                            isMine
                              ? 'bg-stone-800 text-stone-100'
                              : isOther
                              ? 'bg-white/75 text-stone-800'
                              : 'bg-white border border-stone-200 text-stone-600'
                          }`}
                        >
                          {rangeLabel}
                        </span>

                        {isMine && slot ? (
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">
                              {slot.subject}
                            </div>
                            <div className="text-[11px] text-stone-300 truncate">
                              senin dersin · {slot.instructorName}
                            </div>
                          </div>
                        ) : isOther && slot && otherTheme ? (
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">
                              {slot.subject}
                            </div>
                            <div
                              className={`text-[11px] truncate ${otherTheme.subtext}`}
                            >
                              {slot.instructorName}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-stone-500">
                            boş · ayırmak için dokun
                          </span>
                        )}
                      </div>

                      <div className="shrink-0 text-[11px]">
                        {isMine ? (
                          <span className="inline-flex items-center gap-1 rounded-lg bg-stone-800 px-2 py-1 text-stone-200">
                            <X className="h-3 w-3" />
                            <span>iptal</span>
                          </span>
                        ) : isOther ? (
                          <Lock className="h-3.5 w-3.5 opacity-55" />
                        ) : (
                          <span className="text-stone-400">+ ayır</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
};
