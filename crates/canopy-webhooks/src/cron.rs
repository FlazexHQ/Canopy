use canopy_protocol::CanopyError;
use time::OffsetDateTime;

use crate::invalid;

const MONTHS: &[&str] = &["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: &[&str] = &["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

pub(crate) struct Cron {
    fields: [u64; 5],
    either_day: bool,
}

impl Cron {
    pub(crate) fn parse(expression: &str) -> Result<Self, CanopyError> {
        let source = expression.trim().to_ascii_lowercase();
        let source = match source.as_str() {
            "@yearly" | "@annually" => "0 0 1 1 *",
            "@monthly" => "0 0 1 * *",
            "@weekly" => "0 0 * * 0",
            "@daily" | "@midnight" => "0 0 * * *",
            "@hourly" => "0 * * * *",
            other => other,
        };
        let error = || invalid(format!("Invalid cron expression: {expression}"));
        let parts: [&str; 5] =
            source.split_whitespace().collect::<Vec<_>>().try_into().map_err(|_| error())?;
        let [minute, hour, day, month, weekday] = parts;
        let weekday_mask = field(weekday, 0, 7, DAYS).ok_or_else(error)?;
        let cron = Self {
            fields: [
                field(minute, 0, 59, &[]).ok_or_else(error)?,
                field(hour, 0, 23, &[]).ok_or_else(error)?,
                field(day, 1, 31, &[]).ok_or_else(error)?,
                field(month, 1, 12, MONTHS).ok_or_else(error)?,
                (weekday_mask & 0x7f) | (weekday_mask >> 7),
            ],
            either_day: !day.starts_with('*') && !weekday.starts_with('*'),
        };
        cron.search(946_684_800_000, true).ok_or_else(error)?;
        Ok(cron)
    }

    pub(crate) fn search(&self, millis: i64, forward: bool) -> Option<i64> {
        let minute = millis.div_euclid(60_000) + i64::from(forward);
        let mut date = OffsetDateTime::from_unix_timestamp(minute.checked_mul(60)?).ok()?.date();
        let initial_day = date;
        let initial_minute = minute.rem_euclid(1440);
        let [minutes, hours, days, months, weekdays] = self.fields;
        // The Gregorian calendar repeats its month and weekday layout every 400 years.
        for _ in 0..=146_097 {
            let day = days & (1 << date.day()) != 0;
            let weekday = weekdays & (1 << date.weekday().number_days_from_sunday()) != 0;
            let matches_day = if self.either_day { day || weekday } else { day && weekday };
            if matches_day && months & (1 << u8::from(date.month())) != 0 {
                for index in 0..1440 {
                    let candidate = if forward { index } else { 1439 - index };
                    if date == initial_day
                        && ((forward && candidate < initial_minute)
                            || (!forward && candidate > initial_minute))
                    {
                        continue;
                    }
                    if hours & (1 << (candidate / 60)) != 0 && minutes & (1 << (candidate % 60)) != 0 {
                        return date
                            .midnight()
                            .assume_utc()
                            .unix_timestamp()
                            .checked_mul(1000)?
                            .checked_add(candidate * 60_000);
                    }
                }
            }
            date = if forward { date.next_day()? } else { date.previous_day()? };
        }
        None
    }
}

fn field(text: &str, min: u8, max: u8, names: &[&str]) -> Option<u64> {
    let value = |text: &str| {
        let number = if let Some(index) = names.iter().position(|name| *name == text) {
            u8::try_from(index).ok()? + min
        } else {
            digits(text)?.try_into().ok()?
        };
        (min..=max).contains(&number).then_some(number)
    };
    let mut mask = 0;
    for entry in text.split(',') {
        let (range, step) = match entry.split_once('/') {
            Some((range, step)) => (range, Some(digits(step).filter(|step| *step > 0)?)),
            None => (entry, None),
        };
        let (low, high) = if range == "*" {
            (min, max)
        } else if let Some((low, high)) = range.split_once('-') {
            (value(low)?, value(high)?)
        } else {
            let low = value(range)?;
            (low, if step.is_some() { max } else { low })
        };
        if low > high {
            return None;
        }
        for offset in (0..=usize::from(high - low)).step_by(step.unwrap_or(1)) {
            mask |= 1 << (usize::from(low) + offset);
        }
    }
    Some(mask)
}

fn digits(text: &str) -> Option<usize> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(
        text.bytes()
            .fold(0_usize, |value, byte| value.saturating_mul(10).saturating_add(usize::from(byte - b'0'))),
    )
}

#[cfg(test)]
mod tests {
    use super::Cron;

    #[test]
    fn accepts_names_steps_macros_and_sunday_alias() {
        let reference = 946_684_800_000;
        assert_eq!(
            Cron::parse("@daily").ok().and_then(|cron| cron.search(reference, true)),
            Some(reference + 86_400_000)
        );
        assert_eq!(
            Cron::parse("5/20 0 * JAN 7").ok().and_then(|cron| cron.search(reference + 86_400_000, true)),
            Some(reference + 86_400_000 + 5 * 60_000)
        );
        assert_eq!(
            Cron::parse("0 0 15 JAN sun").ok().and_then(|cron| cron.search(reference + 86_400_000, false)),
            Some(reference + 86_400_000)
        );
        assert!(Cron::parse("0 0 30 feb *").is_err());
        assert!(Cron::parse("*/0 * * * *").is_err());
    }
}
