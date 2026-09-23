//! `unipi-kanboard` entry point — parse, dispatch, print.

use clap::Parser;

use kanboard::cli::Cli;
use kanboard::error::Error;
use kanboard::run;

fn main() {
    let cli = Cli::parse();
    let code = match run::dispatch(&cli) {
        Ok(payload) => {
            if cli.json {
                match serde_json::to_string_pretty(&payload) {
                    Ok(text) => println!("{text}"),
                    Err(err) => {
                        eprintln!("unipi-kanboard: cannot serialise output: {err}");
                        std::process::exit(1);
                    }
                }
            } else {
                println!("{}", run::human(&cli, &payload));
            }
            run::exit_code(&cli, &payload)
        }
        Err(err) => {
            report(&cli, &err);
            err.exit_code()
        }
    };
    std::process::exit(code);
}

fn report(cli: &Cli, err: &Error) {
    if cli.json {
        let payload = serde_json::json!({
            "ok": false,
            "error": err.to_string(),
            "kind": match err {
                Error::Usage(_) => "usage",
                Error::NotFound(_) => "not_found",
                Error::Rule(_) => "rule",
                _ => "io",
            },
        });
        eprintln!("{payload}");
    } else {
        eprintln!("unipi-kanboard: {err}");
    }
}
