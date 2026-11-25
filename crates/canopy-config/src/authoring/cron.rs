const MONTHS: &[&str] = &["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: &[&str] = &["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAYS_IN_MONTH: [u32; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

struct Field {
    name: &'static str,
    min: u32,
    max: u32,
    names: &'static [&'static str],
    names_from: u32,
}

const FIELDS: [Field; 5] = [
    Field { name: "minute", min: 0, max: 59, names: &[], names_from: 0 },
    Field { name: "hour", min: 0, max: 23, names: &[], names_from: 0 },
    Field { name: "day of month", min: 1, max: 31, names: &[], names_from: 0 },
    Field { name: "month", min: 1, max: 12, names: MONTHS, names_from: 1 },
    Field { name: "day of week", min: 0, max: 7, names: DAYS, names_from: 0 },
];

fn quote(text: &str) -> String {
    super::resolver::quote(text)
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn value(field: &Field, text: &str) -> Result<u32, String> {
    let lower = text.to_lowercase();
    if let Some(index) = field.names.iter().position(|name| *name == lower) {
        return Ok(u32::try_from(index).unwrap_or(0) + field.names_from);
    }
    if !digits(text) {
        return Err(format!("{} is not a {}", quote(text), field.name));
    }
    let value: u64 = text.parse().unwrap_or(u64::MAX);
    if value < u64::from(field.min) || value > u64::from(field.max) {
        return Err(format!("the {} {value} is outside {} to {}", field.name, field.min, field.max));
    }
    Ok(u32::try_from(value).unwrap_or(0))
}

fn values(field: &Field, text: &str) -> Result<Vec<u32>, String> {
    let mut out = Vec::new();
    for item in text.split(',') {
        let mut parts = item.split('/');
        let range = parts.next().unwrap_or("");
        let step_text = parts.next();
        if parts.next().is_some() || range.is_empty() {
            return Err(format!("{} is malformed", quote(item)));
        }
        let mut step = 1;
        if let Some(step_text) = step_text {
            let parsed = if digits(step_text) { step_text.parse::<u32>().unwrap_or(0) } else { 0 };
            if parsed < 1 {
                return Err(format!("the step {} must be a positive number", quote(step_text)));
            }
            step = parsed;
        }
        let (low, high) = if range == "*" {
            (field.min, field.max)
        } else {
            let mut bounds = range.split('-');
            let from = bounds.next().unwrap_or("");
            let to = bounds.next();
            if bounds.next().is_some() {
                return Err(format!("{} is malformed", quote(range)));
            }
            let low = value(field, from)?;
            let high = match (to, step_text) {
                (Some(to), _) => value(field, to)?,
                (None, None) => low,
                (None, Some(_)) => field.max,
            };
            if high < low {
                return Err(format!("the range {} runs backwards", quote(range)));
            }
            (low, high)
        };
        let mut current = low;
        while current <= high {
            out.push(current);
            current += step;
        }
    }
    Ok(out)
}

/// Checks a five field cron expression (with names, lists, ranges, steps and the `@` macros) the way the
/// webhook scheduler reads it, including that it fires at least once. Returns the message for an invalid one.
pub(crate) fn check(expression: &str) -> Result<(), String> {
    let fail = |message: String| format!("The cron expression {} is not valid: {message}", quote(expression));
    let trimmed = expression.trim();
    let source = match trimmed.to_lowercase().as_str() {
        "@yearly" | "@annually" => "0 0 1 1 *",
        "@monthly" => "0 0 1 * *",
        "@weekly" => "0 0 * * 0",
        "@daily" | "@midnight" => "0 0 * * *",
        "@hourly" => "0 * * * *",
        _ => trimmed,
    };
    let parts: Vec<&str> = source.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(fail(
            "it needs five fields: minute, hour, day of month, month and day of week".to_owned(),
        ));
    }
    let mut sets = Vec::new();
    for (part, field) in parts.iter().zip(FIELDS.iter()) {
        sets.push(values(field, part).map_err(&fail)?);
    }
    let restricted = |index: usize| parts.get(index).is_some_and(|part| !part.starts_with('*'));
    let empty = Vec::new();
    let days = sets.get(2).unwrap_or(&empty);
    let months = sets.get(3).unwrap_or(&empty);
    let fires = if restricted(2) && !restricted(4) {
        months.iter().any(|month| {
            let limit = DAYS_IN_MONTH
                .get(usize::try_from(month.saturating_sub(1)).unwrap_or(0))
                .copied()
                .unwrap_or(0);
            days.iter().any(|day| *day <= limit)
        })
    } else {
        true
    };
    if fires { Ok(()) } else { Err(fail("it never fires".to_owned())) }
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn accepts_macros_names_and_steps() {
        assert_eq!(check("@daily"), Ok(()));
        assert_eq!(check("*/15 9-17 * jan-mar mon-fri"), Ok(()));
        assert_eq!(check("0 0 29 2 *"), Ok(()));
    }

    #[test]
    fn refuses_invalid_and_never_firing_expressions() {
        assert_eq!(
            check("0 0 31 2 *"),
            Err("The cron expression \"0 0 31 2 *\" is not valid: it never fires".to_owned())
        );
        assert_eq!(
            check("61 * * * *"),
            Err("The cron expression \"61 * * * *\" is not valid: the minute 61 is outside 0 to 59"
                .to_owned())
        );
        assert_eq!(
            check("* * *"),
            Err("The cron expression \"* * *\" is not valid: it needs five fields: minute, hour, day of month, month and day of week".to_owned())
        );
        assert_eq!(
            check("*/0 * * * *"),
            Err("The cron expression \"*/0 * * * *\" is not valid: the step \"0\" must be a positive number"
                .to_owned())
        );
    }
}
