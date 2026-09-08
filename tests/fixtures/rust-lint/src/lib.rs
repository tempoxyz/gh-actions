//! Exercise a crates.io dependency in the reusable workflow smoke tests.

pub fn format_number(value: u64) -> String {
    itoa::Buffer::new().format(value).to_owned()
}
