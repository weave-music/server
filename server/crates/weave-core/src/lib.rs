//! Domain types and the provider contract shared across the server and
//! every media source connector (local files, streaming, future plugins).

mod provider;
mod track;

pub use provider::{MediaProvider, ProviderError, ProviderKind, SearchQuery};
pub use track::{Album, Artist, Track, TrackSource};
