//! JavaScript date arithmetic: ISO 8601 durations, `setUTCFullYear` and `setUTCMonth` calendar steps, the time
//! clip to the range of dates, `toISOString`, `toString` in UTC, and the ISO 8601 text a date claim may hold.

const DAY_MS: i64 = 86_400_000;
const MAX_DATE_MS: f64 = 8.64e15;
const MAX_YEAR: f64 = 400_000.0;

pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

pub(crate) fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The JavaScript `TimeClip`: a time outside the range of dates is invalid, others are truncated toward zero.
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn time_clip(time: f64) -> Option<i64> {
    if !time.is_finite() || time.abs() > MAX_DATE_MS {
        return None;
    }
    Some(time.trunc() as i64)
}

fn is_valid(ms: i64) -> bool {
    ms.unsigned_abs() <= 8_640_000_000_000_000
}

/// `Date.prototype.toISOString`, or `None` for an invalid date.
pub(crate) fn iso_string(ms: i64) -> Option<String> {
    if !is_valid(ms) {
        return None;
    }
    let (year, month, day) = civil_from_days(ms.div_euclid(DAY_MS));
    let in_day = ms.rem_euclid(DAY_MS);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

/// `Date.prototype.toString` in the UTC time zone, or `None` for an invalid date.
pub(crate) fn date_string(ms: i64) -> Option<String> {
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if !is_valid(ms) {
        return None;
    }
    let days = ms.div_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    let in_day = ms.rem_euclid(DAY_MS);
    let weekday = WEEKDAYS[usize::try_from(days.rem_euclid(7)).unwrap_or(0)];
    let month_name = MONTHS[usize::try_from(month - 1).unwrap_or(0)];
    let year = if year < 0 { format!("-{:04}", -year) } else { format!("{year:04}") };
    Some(format!(
        "{weekday} {month_name} {day:02} {year} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60
    ))
}

/// The parts of an ISO 8601 duration such as `-P1Y2M` or `PT1.5S`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct Duration {
    pub(crate) negative: bool,
    pub(crate) years: f64,
    pub(crate) months: f64,
    pub(crate) weeks: f64,
    pub(crate) days: f64,
    pub(crate) hours: f64,
    pub(crate) minutes: f64,
    pub(crate) seconds: f64,
}

fn digits_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    end
}

fn number(text: &str) -> f64 {
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// Parses `^([+-])?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$`,
/// the duration grammar of the TypeScript package. `P` and `PT` alone are accepted here.
pub(crate) fn parse_duration(text: &str) -> Option<Duration> {
    let bytes = text.as_bytes();
    let mut duration = Duration::default();
    let mut position = 0;
    match bytes.first() {
        Some(b'+') => position = 1,
        Some(b'-') => {
            duration.negative = true;
            position = 1;
        }
        _ => {}
    }
    if bytes.get(position) != Some(&b'P') {
        return None;
    }
    position += 1;
    let mut date_slot = 0;
    while bytes.get(position).is_some_and(u8::is_ascii_digit) {
        let end = digits_end(bytes, position);
        let value = number(&text[position..end]);
        let slot = b"YMWD".iter().position(|letter| bytes.get(end) == Some(letter))?;
        if slot < date_slot {
            return None;
        }
        match slot {
            0 => duration.years = value,
            1 => duration.months = value,
            2 => duration.weeks = value,
            _ => duration.days = value,
        }
        date_slot = slot + 1;
        position = end + 1;
    }
    if bytes.get(position) == Some(&b'T') {
        position += 1;
        let mut time_slot = 0;
        while bytes.get(position).is_some_and(u8::is_ascii_digit) {
            let mut end = digits_end(bytes, position);
            let fraction = bytes.get(end) == Some(&b'.');
            if fraction {
                let fraction_end = digits_end(bytes, end + 1);
                if fraction_end == end + 1 {
                    return None;
                }
                end = fraction_end;
            }
            let value = number(&text[position..end]);
            let letters: &[u8] = if fraction { b"  S" } else { b"HMS" };
            let slot = letters.iter().position(|letter| *letter != b' ' && bytes.get(end) == Some(letter))?;
            if slot < time_slot {
                return None;
            }
            match slot {
                0 => duration.hours = value,
                1 => duration.minutes = value,
                _ => duration.seconds = value,
            }
            time_slot = slot + 1;
            position = end + 1;
        }
    }
    (position == bytes.len()).then_some(duration)
}

/// Whether `text` is a duration the validator accepts: the grammar of [`parse_duration`], not ending in `P` or
/// `T`.
pub(crate) fn is_duration(text: &str) -> bool {
    parse_duration(text).is_some() && !text.ends_with('P') && !text.ends_with('T')
}

/// `MakeDate(MakeDay(year, month, date), time)` followed by `TimeClip`, for a date of the month and a time
/// within the day taken from a valid date.
#[allow(clippy::cast_possible_truncation)]
fn make_date(year: f64, month: f64, date: i64, time: i64) -> Option<i64> {
    if !year.is_finite() || !month.is_finite() {
        return None;
    }
    let whole_years = (month / 12.0).floor();
    let full_year = year + whole_years;
    if !full_year.is_finite() || full_year.abs() > MAX_YEAR {
        return None;
    }
    let month_index = month - whole_years * 12.0;
    let day = days_from_civil(full_year as i64, month_index as i64 + 1, 1) + date - 1;
    let ms = day.checked_mul(DAY_MS)?.checked_add(time)?;
    is_valid(ms).then_some(ms)
}

/// Shifts a valid date by a duration exactly as the TypeScript `shiftDate` does: `setUTCFullYear`, then
/// `setUTCMonth`, then the weeks, days, hours, minutes and seconds added as milliseconds. `None` when the
/// result leaves the range of dates.
#[allow(clippy::cast_precision_loss)]
pub(crate) fn shift(ms: i64, duration: &Duration) -> Option<i64> {
    let sign = if duration.negative { -1.0 } else { 1.0 };
    let (year, month, day) = civil_from_days(ms.div_euclid(DAY_MS));
    let after_years =
        make_date(year as f64 + sign * duration.years, (month - 1) as f64, day, ms.rem_euclid(DAY_MS))?;
    let (year, month, day) = civil_from_days(after_years.div_euclid(DAY_MS));
    let after_months = make_date(
        year as f64,
        (month - 1) as f64 + sign * duration.months,
        day,
        after_years.rem_euclid(DAY_MS),
    )?;
    let shift = ((duration.weeks * 7.0 + duration.days) * 86_400.0
        + duration.hours * 3600.0
        + duration.minutes * 60.0
        + duration.seconds)
        * 1000.0;
    time_clip(after_months as f64 + sign * shift)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Reads `YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DDTHH:mm[:ss[.fraction]]` with `Z` or a `±HH:mm` offset, as
/// milliseconds since the epoch.
pub(crate) fn iso_date_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let field = |start: usize, len: usize| -> Option<i64> {
        let part = bytes.get(start..start + len)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let (year, month, day) = (field(0, 4)?, field(5, 2)?, field(8, 2)?);
    let (mut hour, mut minute, mut second, mut millis, mut offset) = (0, 0, 0, 0, 0);
    if bytes.len() != 10 {
        if bytes.get(10) != Some(&b'T') || bytes.get(13) != Some(&b':') {
            return None;
        }
        hour = field(11, 2)?;
        minute = field(14, 2)?;
        let mut position = 16;
        if bytes.get(position) == Some(&b':') {
            second = field(17, 2)?;
            position = 19;
            if bytes.get(position) == Some(&b'.') {
                let end = digits_end(bytes, position + 1);
                if end == position + 1 {
                    return None;
                }
                let digits = &text[position + 1..end.min(position + 4)];
                millis = format!("{digits:0<3}").parse().ok()?;
                position = end;
            }
        }
        match bytes.get(position) {
            Some(b'Z') if position + 1 == bytes.len() => {}
            Some(sign @ (b'+' | b'-')) if position + 6 == bytes.len() && bytes[position + 3] == b':' => {
                let hours = field(position + 1, 2)?;
                let minutes = field(position + 4, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                offset = (hours * 60 + minutes) * if *sign == b'-' { -1 } else { 1 };
            }
            _ => return None,
        }
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some((((days * 24 + hour) * 60 + minute - offset) * 60 + second) * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso(text: &str) -> i64 {
        iso_date_ms(text).unwrap()
    }

    #[test]
    fn durations_follow_the_typescript_grammar() {
        let duration = parse_duration("-P1Y2M3W4DT5H6M7.5S").unwrap();
        assert!(duration.negative);
        assert_eq!(
            [
                duration.years,
                duration.months,
                duration.weeks,
                duration.days,
                duration.hours,
                duration.minutes
            ],
            [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
        );
        assert_eq!(duration.seconds, 7.5);
        assert_eq!(parse_duration("PT1M").unwrap().minutes, 1.0);
        assert_eq!(parse_duration("P1M").unwrap().months, 1.0);
        for bad in ["P1D1Y", "PT1.5H", "P1.5D", "PT1H1H", "7 days", "P1", "PT1.S", "P-1D", "p1d"] {
            assert!(parse_duration(bad).is_none(), "{bad}");
        }
        assert!(parse_duration("P").is_some() && !is_duration("P"));
        assert!(parse_duration("-PT").is_some() && !is_duration("-PT"));
        assert!(is_duration("+PT0S"));
    }

    #[test]
    fn shifts_follow_javascript_calendar_arithmetic() {
        let now = iso("2026-11-06T12:00:00Z");
        let shifted = |text: &str| shift(now, &parse_duration(text).unwrap());
        assert_eq!(shifted("-P7D"), Some(iso("2026-10-30T12:00:00Z")));
        assert_eq!(shifted("P1M"), Some(iso("2026-12-06T12:00:00Z")));
        assert_eq!(shifted("P2M"), Some(iso("2027-01-06T12:00:00Z")));
        assert_eq!(shifted("PT0.0005S"), Some(now));
        assert_eq!(shifted("-PT0.0005S"), Some(now - 1));
        assert_eq!(shift(iso("2021-01-31"), &parse_duration("P1M").unwrap()), Some(iso("2021-03-03")));
        assert_eq!(shift(iso("2024-02-29"), &parse_duration("P1Y").unwrap()), Some(iso("2025-03-01")));
        assert_eq!(shifted("-P300000Y"), None);
        assert_eq!(shifted("P99999999999999999999999M"), None);
        assert_eq!(shift(-1, &parse_duration("PT0.0005S").unwrap()), Some(0));
    }

    #[test]
    fn iso_strings_cover_extended_years() {
        assert_eq!(iso_string(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(8_640_000_000_000_000).unwrap(), "+275760-09-13T00:00:00.000Z");
        assert_eq!(iso_string(-62_198_755_200_000).unwrap(), "-000001-01-01T00:00:00.000Z");
        assert_eq!(iso_string(8_640_000_000_000_001), None);
    }

    #[test]
    fn date_claims_need_an_offset_and_a_real_day() {
        assert_eq!(iso("2026-11-06T12:00:00.1239+05:30"), iso("2026-11-06T06:30:00.123Z"));
        assert_eq!(iso("2026-11-06T12:00-01:00"), iso("2026-11-06T13:00:00Z"));
        assert_eq!(iso("1970-01-01"), 0);
        for bad in [
            "2026-11-06T12:00:00",
            "2021-02-29",
            "2026-11-06T24:00:00Z",
            "2026-11-06T12:00:60Z",
            "2026-11-06T12:00:00+24:00",
            "2026-11-06T12:00:00.Z",
            "2026-11-06Z",
            "+002026-11-06T12:00:00Z",
            "",
        ] {
            assert_eq!(iso_date_ms(bad), None, "{bad}");
        }
    }
}
