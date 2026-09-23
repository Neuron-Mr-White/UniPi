//! The transition table and its rules (actors, required comments, final states).

use crate::error::{Error, Result};
use crate::model::{Actor, Staleness, Status};

/// What a transition needs in the way of an added note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comment {
    /// No comment needed.
    NotNeeded,
    /// `--comment` is mandatory; the hint names what it must say.
    Required(&'static str),
}

#[derive(Debug, Clone, Copy)]
pub struct Rule {
    pub from: Status,
    pub to: Status,
    pub actors: &'static [Actor],
    pub comment: Comment,
}

const U: Actor = Actor::User;
const A: Actor = Actor::Agent;
const S: Actor = Actor::System;

const USER: &[Actor] = &[U];
const USER_AGENT: &[Actor] = &[U, A];
const USER_SYSTEM: &[Actor] = &[U, S];
const AGENT_SYSTEM: &[Actor] = &[A, S];
const SYSTEM: &[Actor] = &[S];

/// Every row of the spec's table, in order.
pub const RULES: &[Rule] = &[
    // backlog ↔ todo | user, agent | —
    Rule { from: Status::Backlog, to: Status::Todo, actors: USER_AGENT, comment: Comment::NotNeeded },
    Rule { from: Status::Todo, to: Status::Backlog, actors: USER_AGENT, comment: Comment::NotNeeded },
    // todo → in_progress | system only (claim) | deps satisfied, not claimed
    Rule { from: Status::Todo, to: Status::InProgress, actors: SYSTEM, comment: Comment::NotNeeded },
    // in_progress → in_review | system (run end) | summary note
    Rule { from: Status::InProgress, to: Status::InReview, actors: SYSTEM, comment: Comment::Required("run summary") },
    // in_progress → blocked | agent, system | comment required (what is needed)
    Rule {
        from: Status::InProgress,
        to: Status::Blocked,
        actors: AGENT_SYSTEM,
        comment: Comment::Required("what you need in order to continue"),
    },
    // in_progress (stale) → todo | user, system | note added
    Rule {
        from: Status::InProgress,
        to: Status::Todo,
        actors: USER_SYSTEM,
        comment: Comment::Required("why the stale run is being released"),
    },
    // in_progress (stale) → backlog | user, system | note added
    Rule {
        from: Status::InProgress,
        to: Status::Backlog,
        actors: USER_SYSTEM,
        comment: Comment::Required("why the stale run is being released"),
    },
    // in_review → done | user | —
    Rule { from: Status::InReview, to: Status::Done, actors: USER, comment: Comment::NotNeeded },
    // in_review → todo | user | comment required (rework note)
    Rule {
        from: Status::InReview,
        to: Status::Todo,
        actors: USER,
        comment: Comment::Required("rework note"),
    },
    // in_review → backlog | user | comment required (rework note)
    Rule {
        from: Status::InReview,
        to: Status::Backlog,
        actors: USER,
        comment: Comment::Required("rework note"),
    },
    // blocked → todo | user | comment required (the answer shown to the agent)
    Rule {
        from: Status::Blocked,
        to: Status::Todo,
        actors: USER,
        comment: Comment::Required("the answer, shown to the agent on next claim"),
    },
    // backlog/todo/blocked → cancelled | user only | —
    Rule { from: Status::Backlog, to: Status::Cancelled, actors: USER, comment: Comment::NotNeeded },
    Rule { from: Status::Todo, to: Status::Cancelled, actors: USER, comment: Comment::NotNeeded },
    Rule { from: Status::Blocked, to: Status::Cancelled, actors: USER, comment: Comment::NotNeeded },
    // done/cancelled → archived | user, or auto after archiveAfterDays
    Rule { from: Status::Done, to: Status::Archived, actors: USER_SYSTEM, comment: Comment::NotNeeded },
    Rule { from: Status::Cancelled, to: Status::Archived, actors: USER_SYSTEM, comment: Comment::NotNeeded },
];

pub fn rule_for(from: Status, to: Status) -> Option<&'static Rule> {
    RULES.iter().find(|rule| rule.from == from && rule.to == to)
}

/// Check a move. `comment` is the trimmed `--comment` value (if any).
pub fn check(from: Status, to: Status, actor: Actor, comment: Option<&str>, staleness: Staleness) -> Result<()> {
    if from == to {
        return Err(Error::rule(format!("task is already in {to}")));
    }

    let Some(rule) = rule_for(from, to) else {
        return Err(Error::rule(not_allowed(from, to, actor, staleness)));
    };

    if !rule.actors.contains(&actor) {
        return Err(Error::rule(actor_denied(from, to, actor)));
    }

    if from == Status::InProgress && actor == Actor::User && staleness == Staleness::Running {
        return Err(Error::rule(
            "in_progress → * while the run is alive is system only: the runner that owns it must release it \
             (a user may cancel from the terminal that runs it; if the process died, re-run and confirm staleness)",
        ));
    }

    if from == Status::InProgress && actor == Actor::User && staleness == Staleness::Unknown {
        return Err(Error::rule(
            "in_progress run is claimed on another host and cannot be verified as dead — confirm staleness first",
        ));
    }

    if let Comment::Required(hint) = rule.comment {
        let text = comment.unwrap_or("").trim();
        if text.is_empty() {
            return Err(Error::rule(format!(
                "{} → {} requires --comment ({hint})",
                from.as_str(),
                to.as_str()
            )));
        }
    }

    Ok(())
}

fn actor_denied(from: Status, to: Status, actor: Actor) -> String {
    match (from, to) {
        (Status::Todo, Status::InProgress) => {
            "todo → in_progress is system only — claim it with `claim-next`".to_string()
        }
        (Status::InProgress, Status::InReview) => {
            "in_progress → in_review is system only — the runner writes it when the run ends".to_string()
        }
        (_, Status::Done) if actor == Actor::Agent => {
            "agents cannot mark tasks done — release to in_review and let the user confirm \
             (actor=user is an honour system the skill forbids agents from breaking)"
                .to_string()
        }
        (_, Status::Cancelled) if actor == Actor::Agent => {
            "agents cannot cancel tasks — move your task to blocked with \"suggest cancel: <why>\" \
             (actor=user is an honour system the skill forbids agents from breaking)"
                .to_string()
        }
        (Status::Archived, _) | (_, Status::Archived) => {
            "only done/cancelled tasks can be archived".to_string()
        }
        _ => format!(
            "{} → {} is not allowed for actor {actor} (allowed: {}); actor=user is an honour system the skill forbids agents from breaking",
            from.as_str(),
            to.as_str(),
            rule_for(from, to)
                .map(|rule| rule
                    .actors
                    .iter()
                    .map(|actor| actor.as_str())
                    .collect::<Vec<_>>()
                    .join(", "))
                .unwrap_or_else(|| "nobody".to_string())
        ),
    }
}

fn not_allowed(from: Status, to: Status, actor: Actor, staleness: Staleness) -> String {
    if from == Status::Archived {
        return "archived is final — nothing leaves it".to_string();
    }
    if from.is_final() && to != Status::Archived {
        return format!(
            "{from} is final — nothing moves out of it; use `duplicate` to create a new task instead"
        );
    }
    if to == Status::InProgress {
        return "in_progress is reachable only by claiming a ready todo task (`claim-next`, system)".to_string();
    }
    if to == Status::Archived {
        return match from {
            Status::Done | Status::Cancelled => "only done/cancelled tasks can be archived".to_string(),
            _ => format!("only done/cancelled tasks can be archived ({from} is not finished)"),
        };
    }
    if from == Status::InReview && to == Status::Cancelled {
        return "cancelling from in_review is not allowed — move it back to todo (with a rework note) first, or mark it done".to_string();
    }
    if from == Status::Blocked && to == Status::Backlog {
        return "blocked → backlog is not allowed — unblock to todo with the answer as --comment".to_string();
    }
    if from == Status::Todo && to == Status::Blocked {
        return "only a task in progress can be blocked — claim it first".to_string();
    }
    if from == Status::InProgress && actor == Actor::User && staleness != Staleness::Stale {
        return format!(
            "in_progress → {to} needs a confirmed stale run (pid dead on this host); staleness is {staleness}",
            staleness = staleness.as_str()
        );
    }
    format!(
        "{} → {} is not an allowed transition (see the kanboard transition table)",
        from.as_str(),
        to.as_str()
    )
}

/// Statuses that may follow `status` for the given actor — used by the UI and
/// by `move`'s error hints.
pub fn allowed_targets(from: Status, actor: Actor) -> Vec<Status> {
    RULES
        .iter()
        .filter(|rule| rule.from == from && rule.actors.contains(&actor))
        .map(|rule| rule.to)
        .collect()
}

/// Whether moving to `to` needs a comment.
pub fn comment_required(from: Status, to: Status) -> bool {
    matches!(rule_for(from, to).map(|rule| rule.comment), Some(Comment::Required(_)))
}
