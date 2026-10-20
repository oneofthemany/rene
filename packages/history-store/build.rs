fn main() {
    // A linked static DuckDB is C++ and needs the C++ runtime after it on the
    // link line; the bundled build links it itself.
    if std::env::var_os("CARGO_FEATURE_BUNDLED").is_none() {
        println!("cargo:rustc-link-arg=-lstdc++");
    }
}
