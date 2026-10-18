// Builds argument forms from a tool's advertised JSON Schema.
//
// Omission is a caller choice: empty widgets omit their property instead of
// sending defaults, so REA applies its own documented defaults. Schema shapes
// without a faithful simple widget fall back to a JSON editor.

/** Classifies one property schema into a widget kind. */
export function classify(schema) {
  if (schema === true || schema === undefined) return { kind: "json" };
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type) => type !== "null");
    if (types.length === 1) return classify({ ...schema, type: types[0] });
    return { kind: "json" };
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return classifyVariants(schema, variants);
  if ("const" in schema && isScalar(schema.const))
    return { kind: "enum", values: [schema.const] };
  if (Array.isArray(schema.enum) && schema.enum.every(isScalar))
    return { kind: "enum", values: schema.enum };
  return classifyType(schema);
}

/** anyOf/oneOf: nullable wrappers, constant sets, or constants plus free text. */
function classifyVariants(schema, variants) {
  const present = variants.filter((variant) => variant.type !== "null");
  if (present.length === 1)
    return classify({
      ...schema,
      ...present[0],
      anyOf: undefined,
      oneOf: undefined,
    });
  const constants = present
    .filter((variant) => "const" in variant)
    .map((variant) => variant.const);
  const open = present.filter((variant) => !("const" in variant));
  if (constants.length === present.length && constants.every(isScalar)) {
    return { kind: "enum", values: constants };
  }
  if (
    open.length === 1 &&
    open[0].type === "string" &&
    constants.every((value) => typeof value === "string")
  ) {
    return { kind: "string", suggestions: constants };
  }
  return { kind: "json" };
}

function classifyType(schema) {
  switch (schema.type) {
    case "string":
      return { kind: "string" };
    case "integer":
    case "number":
      return { kind: "number", integer: schema.type === "integer" };
    case "boolean":
      return { kind: "boolean" };
    case "array": {
      const item = schema.items ? classify(schema.items) : { kind: "json" };
      if (
        item.kind === "string" ||
        item.kind === "number" ||
        (item.kind === "enum" &&
          item.values.every((value) => typeof value === "string"))
      ) {
        return { kind: "lines", item };
      }
      return { kind: "json" };
    }
    default:
      return { kind: "json" };
  }
}

function isScalar(value) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Creates a form for an object input schema.
 * @returns {{ element: HTMLElement, read(): { ok: true, args: object } | { ok: false }, write(args: object): void }}
 */
export function createForm(schema) {
  const element = document.createElement("div");
  element.className = "fields";
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const fields = Object.entries(properties).map(([name, propertySchema]) =>
    createField(name, propertySchema, required.has(name)),
  );
  for (const field of fields) element.append(field.element);
  if (fields.length === 0) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "This tool takes no arguments.";
    element.append(note);
  }
  // Keys present in written args but not described by the schema are kept,
  // so switching between JSON and form modes never drops caller input.
  let extra = {};

  return {
    element,
    read() {
      const args = { ...extra };
      let ok = true;
      for (const field of fields) {
        const result = field.read();
        if (!result.ok) {
          ok = false;
          continue;
        }
        if (result.value === undefined) delete args[field.name];
        else args[field.name] = result.value;
      }
      return ok ? { ok: true, args } : { ok: false };
    },
    write(args) {
      extra = {};
      for (const [key, value] of Object.entries(args ?? {})) {
        if (!(key in properties)) extra[key] = value;
      }
      for (const field of fields) field.write(args?.[field.name]);
    },
  };
}

function createField(name, schema, isRequired) {
  const shape = classify(schema);
  const id = `field-${name}-${Math.random().toString(36).slice(2, 8)}`;
  const element = document.createElement("div");
  element.className = "field";

  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = name;
  if (isRequired) {
    const req = document.createElement("span");
    req.className = "req";
    req.textContent = "required";
    label.append(req);
  }
  element.append(label);

  const helpText = [
    schema?.description,
    "default" in (schema ?? {})
      ? `Default when omitted: ${JSON.stringify(schema.default)}.`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  if (helpText) {
    const help = document.createElement("p");
    help.className = "help";
    help.textContent = helpText;
    element.append(help);
  }

  const error = document.createElement("div");
  error.className = "error";
  const widget = createWidget(shape, schema, id);
  element.append(widget.control, error);

  const fail = (message) => {
    element.dataset.invalid = "true";
    error.textContent = message;
    return { ok: false };
  };
  return {
    name,
    element,
    read() {
      element.dataset.invalid = "false";
      error.textContent = "";
      const result = widget.read();
      if (!result.ok) return fail(result.message);
      if (result.value === undefined && isRequired)
        return fail("Enter a value; this argument is required.");
      return result;
    },
    write(value) {
      element.dataset.invalid = "false";
      error.textContent = "";
      widget.write(value);
    },
  };
}

const WIDGETS = {
  enum: enumWidget,
  boolean: booleanWidget,
  number: numberWidget,
  string: stringWidget,
  lines: linesWidget,
  json: jsonWidget,
};

function createWidget(shape, schema, id) {
  return WIDGETS[shape.kind](shape, schema, id);
}

function enumWidget(shape, schema, id) {
  const select = document.createElement("select");
  select.id = id;
  select.append(new Option("(omit)", ""));
  shape.values.forEach((value, index) =>
    select.append(new Option(String(value), String(index))),
  );
  return {
    control: select,
    read: () => ({
      ok: true,
      value:
        select.value === "" ? undefined : shape.values[Number(select.value)],
    }),
    write: (value) => {
      const index = shape.values.indexOf(value);
      select.value = index === -1 ? "" : String(index);
    },
  };
}

function booleanWidget(shape, schema, id) {
  const select = document.createElement("select");
  select.id = id;
  select.append(
    new Option("(omit)", ""),
    new Option("true", "true"),
    new Option("false", "false"),
  );
  return {
    control: select,
    read: () => ({
      ok: true,
      value: select.value === "" ? undefined : select.value === "true",
    }),
    write: (value) =>
      (select.value = typeof value === "boolean" ? String(value) : ""),
  };
}

function numberWidget(shape, schema, id) {
  const input = document.createElement("input");
  input.id = id;
  input.inputMode = shape.integer ? "numeric" : "decimal";
  input.spellcheck = false;
  if ("default" in schema) input.placeholder = String(schema.default);
  return {
    control: input,
    read: () => {
      const text = input.value.trim();
      if (text === "") return { ok: true, value: undefined };
      const value = Number(text);
      if (
        !Number.isFinite(value) ||
        (shape.integer && !Number.isInteger(value))
      ) {
        return {
          ok: false,
          message: shape.integer ? "Enter a whole number." : "Enter a number.",
        };
      }
      return { ok: true, value };
    },
    write: (value) =>
      (input.value = typeof value === "number" ? String(value) : ""),
  };
}

function stringWidget(shape, schema, id) {
  const input = document.createElement("input");
  input.id = id;
  input.spellcheck = false;
  input.autocomplete = "off";
  if ("default" in schema && typeof schema.default === "string")
    input.placeholder = schema.default;
  else if (/absolute .*path/i.test(schema?.description ?? ""))
    input.placeholder = "/absolute/path";
  const control = document.createElement("div");
  control.append(input);
  if (shape.suggestions?.length) {
    const list = document.createElement("datalist");
    list.id = `${id}-options`;
    for (const value of shape.suggestions) list.append(new Option(value));
    input.setAttribute("list", list.id);
    control.append(list);
  }
  // Strings are sent exactly as typed; only an empty field means omission.
  return {
    control,
    read: () => ({
      ok: true,
      value: input.value === "" ? undefined : input.value,
    }),
    write: (value) => (input.value = typeof value === "string" ? value : ""),
  };
}

function linesWidget(shape, schema, id) {
  const textarea = document.createElement("textarea");
  textarea.id = id;
  textarea.spellcheck = false;
  textarea.placeholder = "One value per line";
  const numeric = shape.item.kind === "number";
  return {
    control: textarea,
    read: () => {
      if (textarea.value.trim() === "") return { ok: true, value: undefined };
      const lines = textarea.value.split("\n").filter((line) => line !== "");
      if (!numeric) return { ok: true, value: lines };
      const values = lines.map((line) => Number(line.trim()));
      if (values.some((value) => !Number.isFinite(value)))
        return { ok: false, message: "Each line must be a number." };
      return { ok: true, value: values };
    },
    write: (value) =>
      (textarea.value = Array.isArray(value) ? value.join("\n") : ""),
  };
}

function jsonWidget(shape, schema, id) {
  const textarea = document.createElement("textarea");
  textarea.id = id;
  textarea.spellcheck = false;
  textarea.placeholder = "JSON value";
  return {
    control: textarea,
    read: () => {
      if (textarea.value.trim() === "") return { ok: true, value: undefined };
      try {
        return { ok: true, value: JSON.parse(textarea.value) };
      } catch (cause) {
        return { ok: false, message: `Invalid JSON: ${cause.message}` };
      }
    },
    write: (value) => {
      textarea.value =
        value === undefined ? "" : JSON.stringify(value, null, 2);
      textarea.rows = Math.min(
        14,
        Math.max(3, textarea.value.split("\n").length + 1),
      );
    },
  };
}
