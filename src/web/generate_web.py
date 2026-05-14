from pathlib import Path

Import("env")

project_dir = Path(env["PROJECT_DIR"])

web_dir = project_dir / "src/web"
output_dir = project_dir / "src/web/generated"

output_dir.mkdir(exist_ok=True)

files = [
    ("scope.html", "text/html"),
    ("scope.css", "text/css"),
    ("scope.js", "application/javascript"),
    ("chart.js", "application/javascript"),
    ("chartPlugin.js", "application/javascript"),
]

for filename, mime in files:

    input_file = web_dir / filename

    variable_name = (
        filename
            .replace(".", "_")
            .replace("-", "_")
    )

    output_file = output_dir / f"{variable_name}.h"

    content = input_file.read_text(encoding="utf-8")

    header = f'''#pragma once

#include <pgmspace.h>

const char {variable_name}[] PROGMEM = R"rawliteral(
{content}
)rawliteral";

'''

    output_file.write_text(header, encoding="utf-8")

    print("Generated:", output_file)