use std::process::ExitCode;

use canopy_control::{Actor, AdminAccounts, AdminRole};
use canopy_mongo::mongodb::{Database, bson::DateTime};

use crate::invocation::Invocation;
use crate::meta::{actor, date, field, message};
use crate::{confirmed, output};

pub(crate) async fn run(
    name: &str,
    args: &[String],
    call: &Invocation,
    meta: &Database,
) -> Result<ExitCode, String> {
    let accounts = AdminAccounts::for_cli(meta);
    match (name, args) {
        ("admin create", _) => {
            let (Some(email), Some(role)) = (call.text("email"), call.text("role")) else {
                return Err(
                    "admin create needs --email <email> and --role owner|admin|developer|viewer".into()
                );
            };
            let role =
                AdminRole::parse(role).ok_or("admin create needs --role owner|admin|developer|viewer")?;
            let created = accounts
                .create_bootstrap(email, role, call.text("name"), &Actor::system(&actor()))
                .await
                .map_err(message)?;
            let user = created.get_document("user").map_err(|error| error.to_string())?;
            let password = field(&created, "password")?;
            output(format_args!("{}  {}  {}", field(user, "id")?, field(user, "email")?, role.as_str()))?;
            output(format_args!("Temporary password: {password}"))?;
            let enrollment = if role == AdminRole::Owner {
                ", where the owner also sets up an authenticator app"
            } else {
                ""
            };
            output(format_args!(
                "This is the only time it is shown. It must be changed at the first login{enrollment}."
            ))?;
        }
        ("admin reset-totp", [id]) => {
            let user = accounts
                .find(id)
                .await
                .map_err(message)?
                .ok_or_else(|| format!("No admin {id}. List them with canopy admin list."))?;
            let question = format!(
                "Reset the TOTP of {} ({})? Their sessions end and they set up a new authenticator at the next login.",
                user.email,
                user.role.as_str()
            );
            if !call.has_flag("yes") && !confirmed(&question)? {
                return Ok(ExitCode::FAILURE);
            }
            accounts.reset_totp_for_cli(&user.id, &Actor::system(&actor())).await.map_err(message)?;
            output(format_args!("reset  {}  {}", user.id, user.email))?;
        }
        ("admin list", []) => {
            let users = accounts.list().await.map_err(message)?;
            if users.is_empty() {
                output(format_args!(
                    "No admins yet. Create the first owner with canopy admin create --email <email> --role owner"
                ))?;
            }
            for user in users {
                let totp = if user.totp_enabled { "on " } else { "off" };
                let state = if user.disabled { "disabled" } else { "active  " };
                let login = user
                    .last_login_at
                    .map_or_else(|| Ok("never".into()), |millis| date(&DateTime::from_millis(millis)))?;
                let email_width =
                    user.email.chars().count() + 32_usize.saturating_sub(user.email.encode_utf16().count());
                output(format_args!(
                    "{}  {:<email_width$}  {:<9}  totp {totp}  {state}  last login {login}",
                    user.id,
                    user.email,
                    user.role.as_str()
                ))?;
            }
        }
        _ => return Err(format!("Invalid arguments for {name}")),
    }
    Ok(ExitCode::SUCCESS)
}
