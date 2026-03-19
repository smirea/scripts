import { addMinutes, isValid, parseISO } from 'date-fns';

export function formatOffsetDate(value: string | null | undefined, offset: string | null | undefined): string {
  const date = getOffsetAdjustedDate(value, offset);
  if (!date) {
    return '';
  }
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatOffsetTime(value: string | null | undefined, offset: string | null | undefined): string {
  const date = getOffsetAdjustedDate(value, offset);
  if (!date) {
    return '';
  }
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatDurationMilliseconds(value: number | null | undefined): string {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return '';
  }
  const totalMinutes = Math.round((value as number) / 60_000);
  if (totalMinutes <= 0) {
    return '0m';
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function getOffsetAdjustedDate(value: string | null | undefined, offset: string | null | undefined): Date | null {
  const date = parseIsoDate(value);
  const offsetMinutes = parseUtcOffsetMinutes(offset);
  if (!date || offsetMinutes == null) {
    return null;
  }
  return addMinutes(date, offsetMinutes);
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = parseISO(value);
  return isValid(date) ? date : null;
}

function parseUtcOffsetMinutes(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 60 + minutes);
}
