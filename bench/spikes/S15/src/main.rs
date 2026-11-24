//! Spike S15: the validation errors of async-graphql (dynamic schema) and apollo-compiler next to those of
//! graphql-js, for the queries the Canopy GraphQL oracle would record.

use async_graphql::dynamic::{Field, FieldFuture, FieldValue, Object, Schema, TypeRef};
use async_graphql::Value;

const SDL: &str = "type Todo { _id: ID! title: String done: Boolean } type Query { todos(limit: Int): [Todo!]! todo(id: ID!): Todo }";

pub const QUERIES: [&str; 8] = [
    "{ todos { nope } }",
    "{ todos(limit: \"x\") { title } }",
    "{ todos { title }",
    "{ todo { title } }",
    "{ todos }",
    "query A { todos { title } } query A { todos { _id } }",
    "{ todos(nope: 1) { title } }",
    "{ ...F } fragment F on Missing { x }",
];

#[tokio::main]
async fn main() {
    let todo = Object::new("Todo")
        .field(Field::new("_id", TypeRef::named_nn(TypeRef::ID), |_| FieldFuture::new(async { Ok(Some(Value::from("1"))) })))
        .field(Field::new("title", TypeRef::named(TypeRef::STRING), |_| FieldFuture::new(async { Ok(Some(Value::from("t"))) })))
        .field(Field::new("done", TypeRef::named(TypeRef::BOOLEAN), |_| FieldFuture::new(async { Ok(Some(Value::from(false))) })));
    let query = Object::new("Query")
        .field(
            Field::new("todos", TypeRef::named_nn_list_nn("Todo"), |_| {
                FieldFuture::new(async { Ok(Some(FieldValue::list((0..100).map(|_| FieldValue::NULL)))) })
            })
            .argument(async_graphql::dynamic::InputValue::new("limit", TypeRef::named(TypeRef::INT))),
        )
        .field(
            Field::new("todo", TypeRef::named("Todo"), |_| FieldFuture::new(async { Ok(None::<FieldValue>) }))
                .argument(async_graphql::dynamic::InputValue::new("id", TypeRef::named_nn(TypeRef::ID))),
        );
    let schema = Schema::build("Query", None, None).register(todo).register(query).finish().expect("a schema");
    let compiler = apollo_compiler::Schema::parse_and_validate(SDL, "schema.graphql").expect("SDL");
    for text in QUERIES {
        let response = schema.execute(text).await;
        let async_messages: Vec<String> = response.errors.iter().map(|error| error.message.clone()).collect();
        let apollo_messages: Vec<String> = match apollo_compiler::ExecutableDocument::parse_and_validate(&compiler, text, "q.graphql") {
            Ok(_) => Vec::new(),
            Err(errors) => errors.errors.iter().map(|error| error.error.to_string()).collect(),
        };
        println!("{}", serde_json::json!({ "query": text, "asyncGraphql": async_messages, "apolloCompiler": apollo_messages }));
    }
    let list = "{ todos(limit: 100) { _id title done } }";
    let runs = 2000;
    let started = std::time::Instant::now();
    for _ in 0..runs {
        let response = schema.execute(list).await;
        assert!(response.errors.is_empty());
    }
    let executed = started.elapsed().as_secs_f64() * 1e6 / f64::from(runs);
    let started = std::time::Instant::now();
    for _ in 0..runs {
        let document = apollo_compiler::ExecutableDocument::parse_and_validate(&compiler, list, "q.graphql");
        assert!(document.is_ok());
    }
    let validated = started.elapsed().as_secs_f64() * 1e6 / f64::from(runs);
    println!("{}", serde_json::json!({ "asyncGraphqlExecuteMicros": executed, "apolloParseValidateMicros": validated }));
}
