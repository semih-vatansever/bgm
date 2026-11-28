import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOptimisticSlotChange,
  buildScheduleSlotDocId,
  formatHourSlotRange,
  getShortSubjectLabel,
  getWeekDaysWithDates,
  isOnlineGrade10Course,
  ONLINE_GRADE_10_SCHEDULE_SCOPE,
  resolveSlotToggleAction,
  SCHEDULE_DAYS,
  SCHEDULE_HOURS,
  WeeklyScheduleSlot,
} from './scheduleLogic';
import { BASE_DB } from '../data/database';

test('isOnlineGrade10Course matches ONLY 10th-grade online courses', () => {
  assert.equal(isOnlineGrade10Course({ modality: 'online', gradeClass: '10/a' }), true);
  assert.equal(isOnlineGrade10Course({ modality: 'online', gradeClass: '10/b' }), true);
  assert.equal(isOnlineGrade10Course({ modality: 'online', gradeClass: '10. sınıf' }), true);

  assert.equal(isOnlineGrade10Course({ modality: 'yuzyuze', gradeClass: '10/a' }), false);
  assert.equal(isOnlineGrade10Course({ modality: 'online', gradeClass: '9/a' }), false);
  assert.equal(isOnlineGrade10Course({ modality: 'online', gradeClass: '11/a' }), false);
  assert.equal(isOnlineGrade10Course({ modality: 'online', gradeClass: '6/a' }), false);
  assert.equal(isOnlineGrade10Course({ modality: 'online', gradeClass: '100/a' }), false);
  assert.equal(isOnlineGrade10Course(null), false);
  assert.equal(isOnlineGrade10Course(undefined), false);

  const eligibleCourses = BASE_DB.courses.filter(c => isOnlineGrade10Course(c));
  assert.equal(eligibleCourses.length, 6);
  assert.deepEqual(
    eligibleCourses.map(c => c.id).sort(),
    [
      'online-10a-biy',
      'online-10a-edb',
      'online-10a-fiz',
      'online-10a-ing',
      'online-10a-kim',
      'online-10a-mat',
    ]
  );
});

test('SCHEDULE_HOURS spans 10-11 through 21-22 (12 hourly slots)', () => {
  assert.equal(SCHEDULE_HOURS.length, 12);
  assert.equal(SCHEDULE_HOURS[0], 10);
  assert.equal(SCHEDULE_HOURS[SCHEDULE_HOURS.length - 1], 21);
  assert.equal(formatHourSlotRange(10), '10-11');
  assert.equal(formatHourSlotRange(21), '21-22');
  assert.equal(SCHEDULE_DAYS.length, 7);
});

test('buildScheduleSlotDocId generates deterministic Firestore-safe IDs', () => {
  const id = buildScheduleSlotDocId(ONLINE_GRADE_10_SCHEDULE_SCOPE, 6, 0, 10);
  assert.equal(id, 'online_10_w06_d0_h10');
  assert.match(id, /^[a-zA-Z0-9_\-]+$/);

  const id2 = buildScheduleSlotDocId(ONLINE_GRADE_10_SCHEDULE_SCOPE, 12, 6, 21);
  assert.equal(id2, 'online_10_w12_d6_h21');
});

test('getWeekDaysWithDates computes exact Monday-Sunday dates for week 1 and week 6', () => {
  const w1 = getWeekDaysWithDates(1, '2026-10-19');
  assert.equal(w1.length, 7);
  assert.equal(w1[0].name, 'pazartesi');
  assert.equal(w1[0].shortDateLabel, '19 eki');
  assert.equal(w1[6].name, 'pazar');
  assert.equal(w1[6].shortDateLabel, '25 eki');

  const w6 = getWeekDaysWithDates(6, '2026-10-19');
  assert.equal(w6[0].shortDateLabel, '23 kas');
  assert.equal(w6[6].shortDateLabel, '29 kas');
});

test('resolveSlotToggleAction handles empty claim, own unclaim, and other-instructor protection', () => {
  assert.deepEqual(resolveSlotToggleAction(undefined, 'inst-ilkay'), {
    action: 'claim',
  });

  const ilkaySlot: WeeklyScheduleSlot = {
    id: 'online_10_w06_d0_h18',
    scope: ONLINE_GRADE_10_SCHEDULE_SCOPE,
    weekNumber: 6,
    dayIndex: 0,
    startHour: 18,
    courseId: 'online-10a-mat',
    subject: 'matematik',
    instructorId: 'inst-ilkay',
    instructorName: 'ilkay şahin',
    updatedAt: '2026-11-28T10:00:00.000Z',
  };

  assert.deepEqual(resolveSlotToggleAction(ilkaySlot, 'inst-ilkay'), {
    action: 'unclaim',
  });

  assert.deepEqual(resolveSlotToggleAction(ilkaySlot, 'inst-erva'), {
    action: 'occupied_by_other',
    ownerName: 'ilkay şahin',
    subject: 'matematik',
  });
});

test('applyOptimisticSlotChange cleanly adds and removes slots without mutating original array', () => {
  const initial: WeeklyScheduleSlot[] = [];
  const slot: WeeklyScheduleSlot = {
    id: 'online_10_w06_d2_h19',
    scope: ONLINE_GRADE_10_SCHEDULE_SCOPE,
    weekNumber: 6,
    dayIndex: 2,
    startHour: 19,
    courseId: 'online-10a-kim',
    subject: 'kimya',
    instructorId: 'inst-erva',
    instructorName: 'erva öner',
    updatedAt: '2026-11-28T10:00:00.000Z',
  };

  const afterClaim = applyOptimisticSlotChange(initial, { type: 'claim', slot });
  assert.equal(initial.length, 0);
  assert.equal(afterClaim.length, 1);
  assert.equal(afterClaim[0].id, slot.id);

  const afterUnclaim = applyOptimisticSlotChange(afterClaim, {
    type: 'unclaim',
    slotId: slot.id,
  });
  assert.equal(afterUnclaim.length, 0);
  assert.equal(getShortSubjectLabel('türk dili ve edebiyatı'), 'edebiyat');
});
