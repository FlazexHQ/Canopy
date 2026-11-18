//! A regular expression engine with linear time matching (a Pike VM over code points). It accepts the subset
//! of PCRE that RE2 also accepts, so patterns that need backtracking (backreferences, lookaround, atomic
//! groups, possessive quantifiers, recursion) are refused rather than run.

use std::sync::Arc;

use canopy_protocol::{CanopyError, ErrorCode};

use crate::errors::unsupported_query;

/// Maximum pattern length, in UTF-16 code units as JavaScript counts it.
pub const MAX_PATTERN_LENGTH: usize = 4096;
/// Maximum count in a `{n,m}` quantifier, as in RE2.
pub const MAX_REPEAT: u32 = 1000;
/// Maximum number of VM instructions after expanding counted repetition.
pub const MAX_PROGRAM: usize = 20_000;
/// Maximum `input length × program size` per match before the match fails with an error.
pub const MAX_STEPS: usize = 50_000_000;

type CharTest = Arc<dyn Fn(u32) -> bool + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssertKind {
    Bol,
    Eol,
    Start,
    End,
    EndZ,
    Word,
    NonWord,
}

enum Node {
    Char(CharTest),
    Seq(Vec<Node>),
    Alt(Vec<Node>),
    Rep { node: Box<Node>, min: u32, max: Option<u32> },
    Assert { kind: AssertKind, multiline: bool },
}

enum Inst {
    Char(CharTest),
    Split(usize, usize),
    Jmp(usize),
    Assert { kind: AssertKind, multiline: bool },
    Match,
}

#[derive(Debug, Clone, Copy, Default)]
struct Flags {
    i: bool,
    m: bool,
    s: bool,
    x: bool,
}

fn unsupported(what: &str) -> CanopyError {
    unsupported_query(format!("Regular expression {what} is not supported by the linear time regex engine"))
}

fn syntax(what: &str) -> CanopyError {
    CanopyError::invalid_query(format!("Invalid regular expression: {what}"))
}

fn is_digit(cp: u32) -> bool {
    (0x30..=0x39).contains(&cp)
}

fn is_word_char(cp: u32) -> bool {
    is_digit(cp) || (0x41..=0x5a).contains(&cp) || (0x61..=0x7a).contains(&cp) || cp == 0x5f
}

fn is_space(cp: u32) -> bool {
    cp == 0x20 || (0x09..=0x0d).contains(&cp)
}

fn is_horizontal_space(cp: u32) -> bool {
    matches!(cp, 0x09 | 0x20 | 0xa0 | 0x1680 | 0x180e | 0x2000..=0x200a | 0x202f | 0x205f | 0x3000)
}

fn is_vertical_space(cp: u32) -> bool {
    matches!(cp, 0x0a..=0x0d | 0x85 | 0x2028 | 0x2029)
}

fn posix(name: &str) -> Option<fn(u32) -> bool> {
    Some(match name {
        "alpha" => |cp| (0x41..=0x5a).contains(&cp) || (0x61..=0x7a).contains(&cp),
        "digit" => is_digit,
        "alnum" => |cp| is_digit(cp) || (0x41..=0x5a).contains(&cp) || (0x61..=0x7a).contains(&cp),
        "upper" => |cp| (0x41..=0x5a).contains(&cp),
        "lower" => |cp| (0x61..=0x7a).contains(&cp),
        "space" => is_space,
        "blank" => |cp| cp == 0x20 || cp == 0x09,
        "punct" => |cp| matches!(cp, 0x21..=0x2f | 0x3a..=0x40 | 0x5b..=0x60 | 0x7b..=0x7e),
        "xdigit" => |cp| is_digit(cp) || (0x41..=0x46).contains(&cp) || (0x61..=0x66).contains(&cp),
        "word" => is_word_char,
        "cntrl" => |cp| cp < 0x20 || cp == 0x7f,
        "graph" => |cp| cp > 0x20 && cp < 0x7f,
        "print" => |cp| (0x20..0x7f).contains(&cp),
        _ => return None,
    })
}

fn single_case(mut mapped: impl Iterator<Item = char>) -> Option<u32> {
    let first = mapped.next()?;
    if mapped.next().is_some() { None } else { Some(u32::from(first)) }
}

fn fold_variants(cp: u32) -> Vec<u32> {
    let Some(ch) = char::from_u32(cp) else { return Vec::new() };
    [single_case(ch.to_lowercase()), single_case(ch.to_uppercase())]
        .into_iter()
        .flatten()
        .filter(|variant| *variant != cp)
        .collect()
}

fn caseless(test: CharTest) -> CharTest {
    Arc::new(move |cp| test(cp) || fold_variants(cp).into_iter().any(|variant| test(variant)))
}

fn equals(cp: u32) -> CharTest {
    Arc::new(move |c| c == cp)
}

enum ClassAtom {
    Point(u32),
    Test(CharTest),
}

struct Parser {
    cps: Vec<u32>,
    pos: usize,
    flags: Flags,
}

impl Parser {
    fn peek(&self) -> Option<u32> {
        self.peek_at(0)
    }

    fn peek_at(&self, offset: usize) -> Option<u32> {
        self.cps.get(self.pos + offset).copied()
    }

    fn eat(&mut self, cp: u32) -> bool {
        if self.peek() == Some(cp) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn parse(&mut self) -> Result<Node, CanopyError> {
        let node = self.parse_alt()?;
        if self.pos < self.cps.len() {
            return Err(syntax("unmatched )"));
        }
        Ok(node)
    }

    fn skip_extended(&mut self) {
        if !self.flags.x {
            return;
        }
        while let Some(cp) = self.peek() {
            if is_space(cp) {
                self.pos += 1;
            } else if cp == 0x23 {
                while self.peek().is_some_and(|c| c != 0x0a) {
                    self.pos += 1;
                }
            } else {
                return;
            }
        }
    }

    fn parse_alt(&mut self) -> Result<Node, CanopyError> {
        let mut items = vec![self.parse_seq()?];
        while self.eat(0x7c) {
            items.push(self.parse_seq()?);
        }
        Ok(if items.len() == 1 { items.remove(0) } else { Node::Alt(items) })
    }

    fn parse_seq(&mut self) -> Result<Node, CanopyError> {
        let mut items = Vec::new();
        let saved = self.flags;
        loop {
            self.skip_extended();
            match self.peek() {
                None | Some(0x7c | 0x29) => break,
                Some(_) => {}
            }
            let Some(atom) = self.parse_atom()? else { continue };
            items.push(self.parse_quantifier(atom)?);
        }
        self.flags = saved;
        Ok(if items.len() == 1 { items.remove(0) } else { Node::Seq(items) })
    }

    fn parse_quantifier(&mut self, atom: Node) -> Result<Node, CanopyError> {
        self.skip_extended();
        let (min, max) = match self.peek() {
            Some(0x2a) => {
                self.pos += 1;
                (0, None)
            }
            Some(0x2b) => {
                self.pos += 1;
                (1, None)
            }
            Some(0x3f) => {
                self.pos += 1;
                (0, Some(1))
            }
            Some(0x7b) => match self.try_counted()? {
                Some(counted) => counted,
                None => return Ok(atom),
            },
            _ => return Ok(atom),
        };
        if matches!(atom, Node::Assert { .. }) {
            return Err(syntax("quantifier after an assertion"));
        }
        if self.eat(0x2b) {
            return Err(unsupported("with a possessive quantifier"));
        }
        self.eat(0x3f);
        if matches!(self.peek(), Some(0x2a | 0x2b | 0x3f)) {
            return Err(syntax("nested quantifier"));
        }
        Ok(Node::Rep { node: Box::new(atom), min, max })
    }

    fn read_int(&mut self) -> Option<u64> {
        let mut value: Option<u64> = None;
        while let Some(cp) = self.peek().filter(|cp| is_digit(*cp)) {
            value = Some(value.unwrap_or(0).saturating_mul(10).saturating_add(u64::from(cp - 0x30)));
            self.pos += 1;
        }
        value
    }

    fn try_counted(&mut self) -> Result<Option<(u32, Option<u32>)>, CanopyError> {
        let start = self.pos;
        self.pos += 1;
        let min = self.read_int();
        let mut max = min;
        let mut unbounded = false;
        if min.is_some() && self.eat(0x2c) {
            max = self.read_int();
            unbounded = max.is_none();
        }
        let Some(min) = min else {
            self.pos = start;
            return Ok(None);
        };
        if !self.eat(0x7d) {
            self.pos = start;
            return Ok(None);
        }
        let limit = u64::from(MAX_REPEAT);
        if min > limit || max.is_some_and(|max| max > limit) {
            return Err(unsupported(&format!("with a repetition count above {MAX_REPEAT}")));
        }
        let min = u32::try_from(min).unwrap_or(MAX_REPEAT);
        let max = if unbounded {
            None
        } else {
            Some(max.map_or(min, |max| u32::try_from(max).unwrap_or(MAX_REPEAT)))
        };
        if max.is_some_and(|max| max < min) {
            return Err(syntax("numbers out of order in a {} quantifier"));
        }
        Ok(Some((min, max)))
    }

    fn char_node(&self, test: CharTest) -> Node {
        Node::Char(if self.flags.i { caseless(test) } else { test })
    }

    fn parse_atom(&mut self) -> Result<Option<Node>, CanopyError> {
        let Some(cp) = self.peek() else { return Ok(None) };
        self.pos += 1;
        Ok(match cp {
            0x2e => {
                let test: CharTest = if self.flags.s { Arc::new(|_| true) } else { Arc::new(|c| c != 0x0a) };
                Some(Node::Char(test))
            }
            0x5e => Some(Node::Assert { kind: AssertKind::Bol, multiline: self.flags.m }),
            0x24 => Some(Node::Assert { kind: AssertKind::Eol, multiline: self.flags.m }),
            0x28 => self.parse_group()?,
            0x5b => {
                let class = self.parse_class()?;
                Some(self.char_node(class))
            }
            0x5c => Some(self.parse_escape()?),
            0x2a | 0x2b | 0x3f => return Err(syntax("quantifier does not follow a repeatable item")),
            _ => Some(self.char_node(equals(cp))),
        })
    }

    fn parse_group(&mut self) -> Result<Option<Node>, CanopyError> {
        if !self.eat(0x3f) {
            return self.group_body().map(Some);
        }
        match self.peek() {
            Some(0x3a) => {
                self.pos += 1;
                self.group_body().map(Some)
            }
            Some(0x3d | 0x21) => Err(unsupported("with lookahead")),
            Some(0x3e) => Err(unsupported("with an atomic group")),
            Some(0x28) => Err(unsupported("with a conditional group")),
            Some(cp) if cp == 0x52 || cp == 0x26 || is_digit(cp) => Err(unsupported("with recursion")),
            Some(0x3c) => {
                if matches!(self.peek_at(1), Some(0x3d | 0x21)) {
                    return Err(unsupported("with lookbehind"));
                }
                self.pos += 1;
                self.skip_name(0x3e)?;
                self.group_body().map(Some)
            }
            Some(0x50) => {
                if self.peek_at(1) == Some(0x3c) {
                    self.pos += 2;
                    self.skip_name(0x3e)?;
                    return self.group_body().map(Some);
                }
                Err(unsupported("with a named backreference"))
            }
            Some(0x27) => {
                self.pos += 1;
                self.skip_name(0x27)?;
                self.group_body().map(Some)
            }
            Some(0x23) => {
                while self.peek().is_some_and(|cp| cp != 0x29) {
                    self.pos += 1;
                }
                if !self.eat(0x29) {
                    return Err(syntax("missing ) after a comment"));
                }
                Ok(None)
            }
            _ => self.parse_inline_flags(),
        }
    }

    fn skip_name(&mut self, terminator: u32) -> Result<(), CanopyError> {
        let mut length = 0;
        while let Some(cp) = self.peek().filter(|cp| *cp != terminator) {
            if !is_word_char(cp) {
                return Err(syntax("invalid group name"));
            }
            self.pos += 1;
            length += 1;
        }
        if length == 0 || !self.eat(terminator) {
            return Err(syntax("invalid group name"));
        }
        Ok(())
    }

    fn group_body(&mut self) -> Result<Node, CanopyError> {
        let saved = self.flags;
        let node = self.parse_alt()?;
        self.flags = saved;
        if !self.eat(0x29) {
            return Err(syntax("missing )"));
        }
        Ok(node)
    }

    fn parse_inline_flags(&mut self) -> Result<Option<Node>, CanopyError> {
        let mut on = true;
        let mut next = self.flags;
        loop {
            let Some(cp) = self.peek() else { return Err(syntax("missing ) after inline flags")) };
            self.pos += 1;
            match cp {
                0x29 => {
                    self.flags = next;
                    return Ok(None);
                }
                0x3a => {
                    let saved = self.flags;
                    self.flags = next;
                    let node = self.parse_alt()?;
                    self.flags = saved;
                    if !self.eat(0x29) {
                        return Err(syntax("missing )"));
                    }
                    return Ok(Some(node));
                }
                0x2d => on = false,
                0x69 => next.i = on,
                0x6d => next.m = on,
                0x73 => next.s = on,
                0x78 => next.x = on,
                _ => {
                    let letter = char::from_u32(cp).unwrap_or('?');
                    return Err(unsupported(&format!("with the inline option (?{letter})")));
                }
            }
        }
    }

    fn parse_escape(&mut self) -> Result<Node, CanopyError> {
        let Some(cp) = self.peek() else { return Err(syntax("\\ at end of pattern")) };
        let assert = |kind| Node::Assert { kind, multiline: false };
        let node = match char::from_u32(cp) {
            Some('b') => assert(AssertKind::Word),
            Some('B') => assert(AssertKind::NonWord),
            Some('A') => assert(AssertKind::Start),
            Some('z') => assert(AssertKind::End),
            Some('Z') => assert(AssertKind::EndZ),
            Some(letter @ ('G' | 'K')) => return Err(unsupported(&format!("with \\{letter}"))),
            Some('Q') => return Err(unsupported("with \\Q quoting")),
            _ => {
                let test = self.parse_class_escape(true)?;
                return Ok(self.char_node(test));
            }
        };
        self.pos += 1;
        Ok(node)
    }

    fn parse_class_escape(&mut self, outside_class: bool) -> Result<CharTest, CanopyError> {
        let Some(cp) = self.peek() else { return Err(syntax("\\ at end of pattern")) };
        self.pos += 1;
        let letter = char::from_u32(cp).unwrap_or('\0');
        let test: CharTest = match letter {
            'd' => Arc::new(is_digit),
            'D' => Arc::new(|c| !is_digit(c)),
            'w' => Arc::new(is_word_char),
            'W' => Arc::new(|c| !is_word_char(c)),
            's' => Arc::new(is_space),
            'S' => Arc::new(|c| !is_space(c)),
            'h' => Arc::new(is_horizontal_space),
            'H' => Arc::new(|c| !is_horizontal_space(c)),
            'v' => Arc::new(is_vertical_space),
            'V' => Arc::new(|c| !is_vertical_space(c)),
            't' => equals(0x09),
            'n' => equals(0x0a),
            'r' => equals(0x0d),
            'f' => equals(0x0c),
            'e' => equals(0x1b),
            'a' => equals(0x07),
            'x' => equals(self.parse_hex()?),
            'c' => {
                let Some(next) = self.peek() else { return Err(syntax("\\c at end of pattern")) };
                self.pos += 1;
                let upper =
                    char::from_u32(next).and_then(|c| c.to_uppercase().next()).map_or(next, u32::from);
                equals(upper ^ 0x40)
            }
            '0' => {
                let mut value = 0;
                for _ in 0..2 {
                    match self.peek() {
                        Some(digit @ 0x30..=0x37) => {
                            value = value * 8 + (digit - 0x30);
                            self.pos += 1;
                        }
                        _ => break,
                    }
                }
                equals(value)
            }
            'p' | 'P' => return Err(unsupported("with Unicode property classes")),
            'R' | 'X' | 'u' | 'U' | 'N' | 'C' => return Err(unsupported(&format!("with \\{letter}"))),
            'g' | 'k' => return Err(unsupported("with a backreference")),
            _ if is_digit(cp) => {
                return Err(unsupported(if outside_class {
                    "with a backreference"
                } else {
                    "with an octal escape"
                }));
            }
            _ if is_word_char(cp) => return Err(syntax(&format!("unrecognized escape \\{letter}"))),
            _ => equals(cp),
        };
        Ok(test)
    }

    fn parse_hex(&mut self) -> Result<u32, CanopyError> {
        if self.eat(0x7b) {
            let mut digits = String::new();
            while let Some(cp) = self.peek().filter(|cp| *cp != 0x7d) {
                digits.push(char::from_u32(cp).unwrap_or('?'));
                self.pos += 1;
            }
            let valid =
                (1..=6).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_hexdigit());
            if !self.eat(0x7d) || !valid {
                return Err(syntax("invalid \\x{} escape"));
            }
            let value = u32::from_str_radix(&digits, 16).map_err(|_| syntax("invalid \\x{} escape"))?;
            if value > 0x10_ffff {
                return Err(syntax("code point out of range"));
            }
            return Ok(value);
        }
        let mut value = 0;
        for _ in 0..2 {
            match self.peek().and_then(char::from_u32).and_then(|c| c.to_digit(16)) {
                Some(digit) => {
                    value = value * 16 + digit;
                    self.pos += 1;
                }
                None => break,
            }
        }
        Ok(value)
    }

    fn parse_class(&mut self) -> Result<CharTest, CanopyError> {
        let negate = self.eat(0x5e);
        let mut tests: Vec<CharTest> = Vec::new();
        let mut first = true;
        loop {
            let Some(cp) = self.peek() else {
                return Err(syntax("missing terminating ] for a character class"));
            };
            if cp == 0x5d && !first {
                self.pos += 1;
                break;
            }
            first = false;
            if cp == 0x5b && self.peek_at(1) == Some(0x3a) {
                tests.push(self.parse_posix()?);
                continue;
            }
            let low = self.parse_class_atom()?;
            if self.peek() == Some(0x2d) && self.peek_at(1).is_some_and(|next| next != 0x5d) {
                let low = match low {
                    ClassAtom::Test(test) => {
                        tests.push(test);
                        continue;
                    }
                    ClassAtom::Point(low) => low,
                };
                self.pos += 1;
                let ClassAtom::Point(high) = self.parse_class_atom()? else {
                    return Err(syntax("invalid range in a character class"));
                };
                if high < low {
                    return Err(syntax("range out of order in a character class"));
                }
                tests.push(Arc::new(move |c| c >= low && c <= high));
                continue;
            }
            tests.push(match low {
                ClassAtom::Point(point) => equals(point),
                ClassAtom::Test(test) => test,
            });
        }
        let union: CharTest = Arc::new(move |c| tests.iter().any(|test| test(c)));
        let matcher = if self.flags.i { caseless(union) } else { union };
        Ok(if negate { Arc::new(move |c| !matcher(c)) } else { matcher })
    }

    fn parse_class_atom(&mut self) -> Result<ClassAtom, CanopyError> {
        let Some(cp) = self.peek() else { return Err(syntax("missing terminating ]")) };
        self.pos += 1;
        if cp != 0x5c {
            return Ok(ClassAtom::Point(cp));
        }
        let Some(next) = self.peek() else { return Err(syntax("\\ at end of pattern")) };
        let single = match char::from_u32(next) {
            Some('b') => Some(0x08),
            Some('t') => Some(0x09),
            Some('n') => Some(0x0a),
            Some('r') => Some(0x0d),
            Some('f') => Some(0x0c),
            Some('e') => Some(0x1b),
            Some('a') => Some(0x07),
            _ => None,
        };
        if let Some(single) = single {
            self.pos += 1;
            return Ok(ClassAtom::Point(single));
        }
        if next == 0x78 {
            self.pos += 1;
            return self.parse_hex().map(ClassAtom::Point);
        }
        if !is_word_char(next) {
            self.pos += 1;
            return Ok(ClassAtom::Point(next));
        }
        self.parse_class_escape(false).map(ClassAtom::Test)
    }

    fn parse_posix(&mut self) -> Result<CharTest, CanopyError> {
        self.pos += 2;
        let negate = self.eat(0x5e);
        let mut name = String::new();
        while let Some(cp) = self.peek().filter(|cp| *cp != 0x3a) {
            name.push(char::from_u32(cp).unwrap_or('?'));
            self.pos += 1;
        }
        if !self.eat(0x3a) || !self.eat(0x5d) {
            return Err(syntax("invalid POSIX class"));
        }
        let test = posix(&name).ok_or_else(|| syntax(&format!("unknown POSIX class {name}")))?;
        Ok(if negate { Arc::new(move |c| !test(c)) } else { Arc::new(test) })
    }
}

struct Compiler {
    program: Vec<Inst>,
}

impl Compiler {
    fn emit(&mut self, inst: Inst) -> Result<usize, CanopyError> {
        if self.program.len() >= MAX_PROGRAM {
            return Err(unsupported(&format!("larger than {MAX_PROGRAM} instructions")));
        }
        self.program.push(inst);
        Ok(self.program.len() - 1)
    }

    fn set_split(&mut self, at: usize, x: Option<usize>, y: Option<usize>) {
        if let Some(Inst::Split(sx, sy)) = self.program.get_mut(at) {
            if let Some(x) = x {
                *sx = x;
            }
            if let Some(y) = y {
                *sy = y;
            }
        }
    }

    fn compile(&mut self, node: &Node) -> Result<(), CanopyError> {
        match node {
            Node::Char(test) => {
                self.emit(Inst::Char(Arc::clone(test)))?;
            }
            Node::Assert { kind, multiline } => {
                self.emit(Inst::Assert { kind: *kind, multiline: *multiline })?;
            }
            Node::Seq(items) => {
                for item in items {
                    self.compile(item)?;
                }
            }
            Node::Alt(items) => {
                let mut jumps = Vec::new();
                for (index, item) in items.iter().enumerate() {
                    if index + 1 < items.len() {
                        let split = self.emit(Inst::Split(0, 0))?;
                        self.set_split(split, Some(self.program.len()), None);
                        self.compile(item)?;
                        jumps.push(self.emit(Inst::Jmp(0))?);
                        self.set_split(split, None, Some(self.program.len()));
                    } else {
                        self.compile(item)?;
                    }
                }
                let end = self.program.len();
                for jump in jumps {
                    if let Some(Inst::Jmp(target)) = self.program.get_mut(jump) {
                        *target = end;
                    }
                }
            }
            Node::Rep { node, min, max } => {
                for _ in 0..*min {
                    self.compile(node)?;
                }
                match max {
                    None => {
                        let split = self.emit(Inst::Split(0, 0))?;
                        self.set_split(split, Some(self.program.len()), None);
                        self.compile(node)?;
                        self.emit(Inst::Jmp(split))?;
                        self.set_split(split, None, Some(self.program.len()));
                    }
                    Some(max) => {
                        let mut splits = Vec::new();
                        for _ in *min..*max {
                            let split = self.emit(Inst::Split(0, 0))?;
                            self.set_split(split, Some(self.program.len()), None);
                            splits.push(split);
                            self.compile(node)?;
                        }
                        let end = self.program.len();
                        for split in splits {
                            self.set_split(split, None, Some(end));
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

enum Engine {
    Contains(String),
    StartsWith(String),
    Machine { program: Vec<Inst>, anchored: bool },
}

/// A compiled regular expression that matches in time linear in the input length.
pub struct LinearRegex {
    pattern: String,
    options: String,
    engine: Engine,
}

impl std::fmt::Debug for LinearRegex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinearRegex").field("pattern", &self.pattern).field("options", &self.options).finish()
    }
}

fn parse_options(options: &str) -> Result<Flags, CanopyError> {
    let mut flags = Flags::default();
    for letter in options.chars() {
        match letter {
            'i' => flags.i = true,
            'm' => flags.m = true,
            's' => flags.s = true,
            'x' => flags.x = true,
            'u' => {}
            other => return Err(syntax(&format!("unknown option {other}"))),
        }
    }
    Ok(flags)
}

fn is_literal_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || " _,;:!@%&=~<>/'\"-".contains(ch)
}

/// Compiles a MongoDB regular expression for in process matching. Fails with an `InvalidQueryError` for
/// invalid patterns, and with an `UnsupportedQueryError` for patterns a linear time engine cannot run.
pub fn compile_regex(pattern: &str, options: &str) -> Result<LinearRegex, CanopyError> {
    if pattern.encode_utf16().count() > MAX_PATTERN_LENGTH {
        return Err(CanopyError::invalid_query(format!(
            "Regular expression longer than {MAX_PATTERN_LENGTH} characters"
        )));
    }
    if pattern.contains('\0') {
        return Err(syntax("NUL character in pattern"));
    }
    let flags = parse_options(options)?;
    let ast = Parser { cps: pattern.chars().map(u32::from).collect(), pos: 0, flags }.parse()?;
    let finish = |engine| LinearRegex { pattern: pattern.to_owned(), options: options.to_owned(), engine };
    if !flags.i && !flags.x {
        let (anchor, text) = match pattern.strip_prefix('^') {
            Some(rest) => (true, rest),
            None => (false, pattern),
        };
        if !text.is_empty() && text.chars().all(is_literal_char) {
            if !anchor {
                return Ok(finish(Engine::Contains(text.to_owned())));
            }
            if !flags.m {
                return Ok(finish(Engine::StartsWith(text.to_owned())));
            }
        }
    }
    let mut compiler = Compiler { program: Vec::new() };
    compiler.compile(&ast)?;
    compiler.emit(Inst::Match)?;
    let anchored = matches!(
        compiler.program.first(),
        Some(
            Inst::Assert { kind: AssertKind::Start, .. }
                | Inst::Assert { kind: AssertKind::Bol, multiline: false }
        )
    );
    Ok(finish(Engine::Machine { program: compiler.program, anchored }))
}

/// Returns true when `pattern` compiles under the linear time engine.
pub fn is_linear_regex(pattern: &str, options: &str) -> bool {
    compile_regex(pattern, options).is_ok()
}

fn check_assert(kind: AssertKind, multiline: bool, cps: &[u32], at: usize) -> bool {
    let length = cps.len();
    match kind {
        AssertKind::Bol => at == 0 || (multiline && cps.get(at.wrapping_sub(1)) == Some(&0x0a)),
        AssertKind::Eol if multiline => at == length || cps.get(at) == Some(&0x0a),
        AssertKind::Eol | AssertKind::EndZ => {
            at == length || (at + 1 == length && cps.get(at) == Some(&0x0a))
        }
        AssertKind::Start => at == 0,
        AssertKind::End => at == length,
        AssertKind::Word | AssertKind::NonWord => {
            let before = at > 0 && cps.get(at - 1).is_some_and(|cp| is_word_char(*cp));
            let after = cps.get(at).is_some_and(|cp| is_word_char(*cp));
            if kind == AssertKind::Word { before != after } else { before == after }
        }
    }
}

impl LinearRegex {
    /// The pattern.
    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    /// The option letters as given.
    pub fn options(&self) -> &str {
        &self.options
    }

    /// Returns true when the pattern matches anywhere in `input`. Fails with `CANOPY_TIMEOUT` when the input is
    /// too large to match in process.
    pub fn test(&self, input: &str) -> Result<bool, CanopyError> {
        match &self.engine {
            Engine::Contains(text) => Ok(input.contains(text.as_str())),
            Engine::StartsWith(text) => Ok(input.starts_with(text.as_str())),
            Engine::Machine { program, anchored } => run(program, *anchored, input),
        }
    }
}

fn run(program: &[Inst], anchored: bool, input: &str) -> Result<bool, CanopyError> {
    let cps: Vec<u32> = input.chars().map(u32::from).collect();
    if (cps.len() + 1).saturating_mul(program.len()) > MAX_STEPS {
        return Err(CanopyError::new(
            ErrorCode::Timeout,
            "Regular expression input is too large to match in process",
        ));
    }
    let mut seen = vec![usize::MAX; program.len()];
    let mut stack = Vec::new();
    let mut current = Vec::with_capacity(program.len());
    let mut next = Vec::with_capacity(program.len());
    for at in 0..=cps.len() {
        if at == 0 || !anchored {
            add(program, &mut seen, &mut stack, &cps, &mut current, 0, at, at);
        } else if current.is_empty() {
            return Ok(false);
        }
        next.clear();
        let cp = cps.get(at).copied();
        for &pc in &current {
            match &program[pc] {
                Inst::Match => return Ok(true),
                Inst::Char(test) => {
                    if let Some(cp) = cp {
                        if test(cp) {
                            add(program, &mut seen, &mut stack, &cps, &mut next, pc + 1, at + 1, at + 1);
                        }
                    }
                }
                _ => {}
            }
        }
        std::mem::swap(&mut current, &mut next);
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)]
fn add(
    program: &[Inst],
    seen: &mut [usize],
    stack: &mut Vec<usize>,
    cps: &[u32],
    list: &mut Vec<usize>,
    start: usize,
    at: usize,
    stamp: usize,
) {
    stack.clear();
    stack.push(start);
    while let Some(pc) = stack.pop() {
        if seen[pc] == stamp {
            continue;
        }
        seen[pc] = stamp;
        match &program[pc] {
            Inst::Jmp(x) => stack.push(*x),
            Inst::Split(x, y) => {
                stack.push(*y);
                stack.push(*x);
            }
            Inst::Assert { kind, multiline } => {
                if check_assert(*kind, *multiline, cps, at) {
                    stack.push(pc + 1);
                }
            }
            _ => list.push(pc),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(pattern: &str, options: &str, input: &str) -> bool {
        compile_regex(pattern, options).unwrap().test(input).unwrap()
    }

    fn refusal(pattern: &str) -> (String, &'static str) {
        let error = compile_regex(pattern, "").unwrap_err();
        (error.message().to_owned(), error.name())
    }

    #[test]
    fn matches_common_patterns() {
        assert!(matches("^ab+c$", "", "abbbc"));
        assert!(!matches("^ab+c$", "", "abbbcd"));
        assert!(matches("a.c", "", "xxabcxx"));
        assert!(!matches("a.c", "", "a\nc"));
        assert!(matches("a.c", "s", "a\nc"));
        assert!(matches("^b", "m", "a\nb"));
        assert!(!matches("^b", "", "a\nb"));
        assert!(matches("(?i)hello", "", "HeLLo"));
        assert!(matches("x{2,3}y", "", "xxy"));
        assert!(!matches("^x{2,3}y", "", "xy"));
        assert!(matches("[a-c]+\\d", "", "cab7"));
        assert!(matches("[^[:alpha:]]", "", "ab1"));
        assert!(matches("\\bword\\b", "", "a word here"));
        assert!(!matches("\\bword\\b", "", "swordfish"));
        assert!(matches("caf\\x{e9}", "", "café"));
        assert!(matches("STRASSE|é", "i", "É"));
        assert!(matches("a # comment\n b", "x", "ab"));
        assert!(matches("end$", "", "the end\n"));
        assert!(!matches("end\\z", "", "the end\n"));
        assert!(matches("(?<name>a)(?:b|c)", "", "ac"));
    }

    #[test]
    fn literal_patterns_use_substring_tests() {
        assert!(matches("^abc", "", "abcdef"));
        assert!(!matches("^abc", "", "xabc"));
        assert!(matches("b c", "", "ab cd"));
        assert!(matches("^abc", "m", "x\nabc"));
    }

    #[test]
    fn refuses_patterns_that_need_backtracking() {
        let name = "UnsupportedQueryError";
        assert_eq!(refusal("(a)\\1").1, name);
        assert_eq!(refusal("a(?=b)").1, name);
        assert_eq!(refusal("(?<=a)b").1, name);
        assert_eq!(refusal("(?>a)").1, name);
        assert_eq!(refusal("a++").1, name);
        assert_eq!(refusal("a{1001}").1, name);
        assert_eq!(refusal("\\p{L}").1, name);
        assert_eq!(
            refusal("a(?=b)").0,
            "Regular expression with lookahead is not supported by the linear time regex engine"
        );
    }

    #[test]
    fn refuses_invalid_patterns_with_the_typescript_messages() {
        assert_eq!(refusal("(a"), ("Invalid regular expression: missing )".to_owned(), "InvalidQueryError"));
        assert_eq!(refusal("a)").0, "Invalid regular expression: unmatched )");
        assert_eq!(
            refusal("*a").0,
            "Invalid regular expression: quantifier does not follow a repeatable item"
        );
        assert_eq!(
            refusal("a{3,2}").0,
            "Invalid regular expression: numbers out of order in a {} quantifier"
        );
        assert_eq!(refusal("[b-a]").0, "Invalid regular expression: range out of order in a character class");
        assert_eq!(refusal("\\q").0, "Invalid regular expression: unrecognized escape \\q");
        assert_eq!(refusal("^*").0, "Invalid regular expression: quantifier after an assertion");
        assert_eq!(
            compile_regex("a", "g").unwrap_err().message(),
            "Invalid regular expression: unknown option g"
        );
    }

    #[test]
    fn exponential_patterns_run_in_linear_time() {
        let input = format!("{}!", "a".repeat(20_000));
        let started = std::time::Instant::now();
        assert!(!matches("^(a|a)*$", "", &input));
        assert!(!matches("^(a+)+$", "", &input));
        assert!(started.elapsed().as_secs() < 5);
    }

    #[test]
    fn oversized_inputs_fail_with_a_timeout() {
        let regex = compile_regex("(a|b){1000}", "").unwrap();
        let error = regex.test(&"a".repeat(20_000)).unwrap_err();
        assert_eq!(error.code(), ErrorCode::Timeout);
    }
}
