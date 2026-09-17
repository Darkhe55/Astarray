using System;
using System.Collections.Generic;

namespace Sample {
  // 注释
  class Example {
    string verbatim = @"C:/path // not a comment";
    string raw = """raw "quoted" text // still raw""";
    void Run() {
      using (var stream = new MemoryStream()) {
        _ = stream;
      }
    }
  }
}
