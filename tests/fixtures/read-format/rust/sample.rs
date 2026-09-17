// 行注释
/// 文档注释
use std::collections::HashMap;
use std::fmt::{
    self,
    Debug,
};
extern crate serde;

/* 外层块注释 /* 嵌套内层 */ 仍在注释中 */
fn main() {
    let text: &'static str = "// 字符串里的斜杠";
    let raw = r#"// raw 里的斜杠不是注释"#;
    let character = 'a';
    let value = 1;
}
