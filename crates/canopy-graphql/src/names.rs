//! The GraphQL names of collections and fields: types, queries and mutations derived from collection names,
//! and field names made valid.

fn is_name_start(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphabetic()
}

fn is_name_byte(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphanumeric()
}

/// Whether `name` is a valid GraphQL name that does not use the reserved `__` prefix.
pub fn is_graphql_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    match bytes.first() {
        Some(&first) if is_name_start(first) => {}
        _ => return false,
    }
    bytes.iter().all(|&byte| is_name_byte(byte)) && !name.starts_with("__")
}

fn words(name: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(name.len() + 4);
    let mut previous: Option<char> = None;
    for character in name.chars() {
        if let Some(before) = previous
            && (before.is_ascii_lowercase() || before.is_ascii_digit())
            && character.is_ascii_uppercase()
        {
            spaced.push(' ');
        }
        spaced.push(character);
        previous = Some(character);
    }
    spaced
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `user_profiles` and `userProfiles` become `UserProfiles`.
pub fn pascal_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for word in words(name) {
        let mut characters = word.chars();
        if let Some(first) = characters.next() {
            out.push(first.to_ascii_uppercase());
            out.extend(characters);
        }
    }
    out
}

fn lower_first(text: &str) -> String {
    let mut characters = text.chars();
    match characters.next() {
        Some(first) => {
            let mut out = String::with_capacity(text.len());
            out.push(first.to_ascii_lowercase());
            out.extend(characters);
            out
        }
        None => String::new(),
    }
}

/// `user_profiles` becomes `userProfiles`; a name that starts with a digit gets a leading `_`.
pub fn camel_case(name: &str) -> String {
    let camel = lower_first(&pascal_case(name));
    if camel.as_bytes().first().is_some_and(u8::is_ascii_digit) { format!("_{camel}") } else { camel }
}

const IRREGULAR: [(&str, &str); 10] = [
    ("people", "person"),
    ("children", "child"),
    ("men", "man"),
    ("women", "woman"),
    ("mice", "mouse"),
    ("geese", "goose"),
    ("data", "datum"),
    ("indices", "index"),
    ("statuses", "status"),
    ("addresses", "address"),
];

const UNCOUNTABLE: [&str; 7] = ["news", "series", "species", "sheep", "fish", "equipment", "information"];

fn ends_with_ignoring_case(word: &str, suffix: &str) -> bool {
    word.len() >= suffix.len()
        && word.is_char_boundary(word.len() - suffix.len())
        && word[word.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

fn without_last(word: &str, count: usize) -> &str {
    let mut end = word.len();
    for _ in 0..count {
        end = word[..end].char_indices().next_back().map_or(0, |(index, _)| index);
    }
    &word[..end]
}

/// An English singular for a collection name: `todos` gives `todo`, `categories` gives `category`.
pub fn singularize(word: &str) -> String {
    let lower = word.to_lowercase();
    if UNCOUNTABLE.contains(&lower.as_str()) {
        return word.to_owned();
    }
    if let Some((_, singular)) = IRREGULAR.iter().find(|(plural, _)| *plural == lower) {
        let first = word.chars().next().map(String::from).unwrap_or_default();
        return format!("{first}{}", &singular[1..]);
    }
    if ends_with_ignoring_case(word, "ies") {
        let stem = &word[..word.len() - 3];
        if stem
            .chars()
            .next_back()
            .is_some_and(|before| !matches!(before.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u'))
        {
            return format!("{stem}y");
        }
    }
    for suffix in ["sses", "shes", "ches", "xes", "zes"] {
        if ends_with_ignoring_case(word, suffix) {
            return without_last(word, 2).to_owned();
        }
    }
    if ends_with_ignoring_case(word, "ss")
        || ends_with_ignoring_case(word, "us")
        || ends_with_ignoring_case(word, "is")
    {
        return word.to_owned();
    }
    if ends_with_ignoring_case(word, "s") {
        return without_last(word, 1).to_owned();
    }
    word.to_owned()
}

/// Turns a field name into a GraphQL name: valid names are kept, others have every invalid character
/// replaced by `_` and get a leading `_` when they start with a digit or the reserved `__`.
pub fn field_name(name: &str) -> String {
    if is_graphql_name(name) {
        return name.to_owned();
    }
    let mut out: String = name
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if is_name_byte(byte) => char::from(byte),
            _ => '_',
        })
        .collect();
    if out.is_empty() || out.as_bytes()[0].is_ascii_digit() || out.starts_with("__") {
        out = format!("_{}", out.trim_start_matches('_'));
    }
    if out == "_" { "_field".to_owned() } else { out }
}

/// The GraphQL names of one collection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollectionNames {
    /// The object type, such as `Todo`.
    pub type_name: String,
    /// The list query, such as `todos`.
    pub list: String,
    /// The query by `_id`, such as `todo`.
    pub one: String,
    /// The count query, such as `todosCount`.
    pub count: String,
    /// The singular used in mutation names, such as `Todo` in `insertTodo`.
    pub singular: String,
    /// The plural used in bulk mutation names, such as `Todos` in `updateTodos`.
    pub plural: String,
}

/// Derives the names of a collection: `todos` becomes type `Todo` with queries `todos`, `todo` and
/// `todosCount`. `type_name` overrides the singular.
pub fn collection_names(collection: &str, type_name: Option<&str>) -> CollectionNames {
    let last = collection.rsplit('.').next().unwrap_or(collection);
    let type_name = match type_name {
        Some(name) => name.to_owned(),
        None => pascal_case(&singularize(last)),
    };
    let list = camel_case(collection);
    let singular = lower_first(&type_name);
    let one = if singular == list { format!("{list}ById") } else { singular };
    let plural = pascal_case(collection);
    CollectionNames {
        count: format!("{list}Count"),
        plural: if plural == type_name { format!("{plural}List") } else { plural },
        singular: type_name.clone(),
        type_name: if type_name.is_empty() { "Document".to_owned() } else { type_name },
        one,
        list,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphql_names_refuse_the_reserved_prefix_and_invalid_characters() {
        for name in ["a", "_a", "A_1", "_"] {
            assert!(is_graphql_name(name), "{name}");
        }
        for name in ["", "1a", "__a", "a-b", "a.b", "é"] {
            assert!(!is_graphql_name(name), "{name}");
        }
    }

    #[test]
    fn cases_split_on_case_changes_and_separators() {
        assert_eq!(pascal_case("user_profiles"), "UserProfiles");
        assert_eq!(pascal_case("userProfiles"), "UserProfiles");
        assert_eq!(pascal_case("HTTPRequests"), "HTTPRequests");
        assert_eq!(pascal_case("a1B"), "A1B");
        assert_eq!(pascal_case("app.todo-items"), "AppTodoItems");
        assert_eq!(camel_case("user_profiles"), "userProfiles");
        assert_eq!(camel_case("2fa_codes"), "_2faCodes");
        assert_eq!(camel_case("--"), "");
    }

    #[test]
    fn singulars_follow_the_english_rules_of_the_typescript_package() {
        let cases = [
            ("todos", "todo"),
            ("categories", "category"),
            ("keys", "key"),
            ("boxes", "box"),
            ("classes", "class"),
            ("dishes", "dish"),
            ("matches", "match"),
            ("buzzes", "buzz"),
            ("status", "status"),
            ("bus", "bus"),
            ("analysis", "analysis"),
            ("People", "Person"),
            ("Data", "Datum"),
            ("sheep", "sheep"),
            ("News", "News"),
            ("ies", "ie"),
            ("aies", "aie"),
            ("éies", "éy"),
            ("BERRIES", "BERRy"),
            ("todo", "todo"),
        ];
        for (plural, singular) in cases {
            assert_eq!(singularize(plural), singular, "{plural}");
        }
    }

    #[test]
    fn field_names_replace_invalid_characters() {
        assert_eq!(field_name("title"), "title");
        assert_eq!(field_name("first-name"), "first_name");
        assert_eq!(field_name("1st"), "_1st");
        assert_eq!(field_name("__proto"), "_proto");
        assert_eq!(field_name("$"), "_field");
        assert_eq!(field_name(""), "_field");
        assert_eq!(field_name("é"), "_field");
        assert_eq!(field_name("a😀"), "a__", "one underscore per UTF-16 unit, as in JavaScript");
    }

    #[test]
    fn collection_names_derive_types_queries_and_mutations() {
        let todos = collection_names("todos", None);
        assert_eq!(
            todos,
            CollectionNames {
                type_name: "Todo".into(),
                list: "todos".into(),
                one: "todo".into(),
                count: "todosCount".into(),
                singular: "Todo".into(),
                plural: "Todos".into(),
            }
        );
        let people = collection_names("people", None);
        assert_eq!(
            (people.type_name.as_str(), people.one.as_str(), people.plural.as_str()),
            ("Person", "person", "People")
        );
        let sheep = collection_names("sheep", None);
        assert_eq!((sheep.one.as_str(), sheep.plural.as_str()), ("sheepById", "SheepList"));
        let dotted = collection_names("app.user_profiles", None);
        assert_eq!((dotted.type_name.as_str(), dotted.list.as_str()), ("UserProfile", "appUserProfiles"));
        let renamed = collection_names("people", Some("Human"));
        assert_eq!((renamed.type_name.as_str(), renamed.one.as_str()), ("Human", "human"));
        assert_eq!(collection_names("--", None).type_name, "Document");
    }
}
