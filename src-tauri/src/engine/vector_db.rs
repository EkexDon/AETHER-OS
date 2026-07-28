use std::path::Path;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// Smallest embedding width accepted by the local index.
pub const MIN_EMBEDDING_DIMENSION: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VectorMatch {
    pub id: String,
    pub text: String,
    pub score: f32,
}

pub struct VectorEngine {
    storage_dir: std::path::PathBuf,
    dimension: RwLock<Option<usize>>,
}

impl VectorEngine {
    pub async fn new(storage_dir: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(storage_dir)?;
        let mut dimension = None;
        for entry in std::fs::read_dir(storage_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                if let Ok(record) =
                    serde_json::from_slice::<StoredVector>(&std::fs::read(entry.path())?)
                {
                    dimension = Some(record.vector.len());
                    break;
                }
            }
        }
        Ok(Self {
            storage_dir: storage_dir.to_path_buf(),
            dimension: RwLock::new(dimension),
        })
    }

    fn enforce_dimension(&self, length: usize) -> Result<(), AetherError> {
        let mut current = self
            .dimension
            .write()
            .unwrap_or_else(|error| error.into_inner());
        match *current {
            Some(existing) if existing != length => Err(AetherError::Vector(format!(
                "index stores {existing}-dimensional vectors but received {length}; re-index after changing the embedding model"
            ))),
            Some(_) => Ok(()),
            None => {
                *current = Some(length);
                Ok(())
            }
        }
    }

    /// Dimension currently stored in this index, if any vector has been written.
    pub fn dimension(&self) -> Option<usize> {
        *self
            .dimension
            .read()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub async fn upsert_vector(
        &self,
        id: &str,
        vector: Vec<f32>,
        text: &str,
    ) -> Result<(), AetherError> {
        validate_vector(&vector)?;
        self.enforce_dimension(vector.len())?;
        if id.trim().is_empty() || text.trim().is_empty() {
            return Err(AetherError::InvalidInput(
                "vector id and text are required".to_owned(),
            ));
        }
        let record = StoredVector {
            id: id.to_owned(),
            vector,
            text: text.to_owned(),
        };
        let file = self
            .storage_dir
            .join(format!("{}.json", stable_file_id(id)));
        std::fs::write(
            file,
            serde_json::to_vec(&record).map_err(|error| AetherError::Vector(error.to_string()))?,
        )?;
        Ok(())
    }

    pub async fn search_similar(
        &self,
        query_vector: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<VectorMatch>, AetherError> {
        validate_vector(&query_vector)?;
        if top_k == 0 {
            return Ok(Vec::new());
        }
        let mut matches = Vec::new();
        for entry in std::fs::read_dir(&self.storage_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                let record: StoredVector = serde_json::from_slice(&std::fs::read(entry.path())?)
                    .map_err(|error| AetherError::Vector(error.to_string()))?;
                if record.vector.len() != query_vector.len() {
                    continue;
                }
                matches.push(VectorMatch {
                    id: record.id,
                    text: record.text,
                    score: cosine_similarity(&query_vector, &record.vector),
                });
            }
        }
        matches.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.id.cmp(&right.id))
        });
        matches.truncate(top_k);
        Ok(matches)
    }
}

#[derive(Serialize, Deserialize)]
struct StoredVector {
    id: String,
    vector: Vec<f32>,
    text: String,
}

fn validate_vector(vector: &[f32]) -> Result<(), AetherError> {
    if vector.len() < MIN_EMBEDDING_DIMENSION {
        return Err(AetherError::InvalidInput(format!(
            "embedding must contain at least {MIN_EMBEDDING_DIMENSION} dimensions, received {}",
            vector.len()
        )));
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(AetherError::InvalidInput(
            "embedding contains non-finite values".to_owned(),
        ));
    }
    Ok(())
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    let (dot, left_norm, right_norm) = left
        .iter()
        .zip(right)
        .fold((0.0_f32, 0.0_f32, 0.0_f32), |(dot, ln, rn), (l, r)| {
            (dot + l * r, ln + l * l, rn + r * r)
        });
    if left_norm == 0.0 || right_norm == 0.0 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

fn stable_file_id(id: &str) -> String {
    id.bytes().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::VectorEngine;
    use tempfile::tempdir;

    const DIMENSION: usize = 768;

    #[tokio::test]
    async fn retrieves_the_nearest_vector_first() {
        let directory = tempdir().expect("temp directory");
        let engine = VectorEngine::new(directory.path()).await.expect("engine");
        let mut first = vec![0.0; DIMENSION];
        first[0] = 1.0;
        let mut second = vec![0.0; DIMENSION];
        second[1] = 1.0;
        engine
            .upsert_vector("first", first.clone(), "first text")
            .await
            .expect("insert first");
        engine
            .upsert_vector("second", second, "second text")
            .await
            .expect("insert second");
        let matches = engine.search_similar(first, 1).await.expect("search");
        assert_eq!(matches[0].id, "first");
        assert_eq!(matches[0].score, 1.0);
        assert_eq!(engine.dimension(), Some(DIMENSION));
    }

    #[tokio::test]
    async fn rejects_vectors_from_a_different_embedding_model() {
        let directory = tempdir().expect("temp directory");
        let engine = VectorEngine::new(directory.path()).await.expect("engine");
        engine
            .upsert_vector("first", vec![0.5; DIMENSION], "first text")
            .await
            .expect("first insert must succeed");
        let error = engine
            .upsert_vector("second", vec![0.5; 384], "second text")
            .await
            .expect_err("dimension change must be rejected");
        assert!(error.to_string().contains("re-index"));
    }

    #[tokio::test]
    async fn restores_the_stored_dimension_after_restart() {
        let directory = tempdir().expect("temp directory");
        let engine = VectorEngine::new(directory.path()).await.expect("engine");
        engine
            .upsert_vector("first", vec![0.25; DIMENSION], "persisted")
            .await
            .expect("insert must succeed");
        let reopened = VectorEngine::new(directory.path())
            .await
            .expect("reopen must succeed");
        assert_eq!(reopened.dimension(), Some(DIMENSION));
    }
}
