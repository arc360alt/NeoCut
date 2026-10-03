use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::BlendMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    pub width: u32,
    pub height: u32,
    pub clear: CanvasClearDescriptor,
    pub items: Vec<FrameItemDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasClearDescriptor {
    pub color: [f32; 4],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FrameItemDescriptor {
    Layer(LayerDescriptor),
    SceneEffect {
        // `rename_all` on the enum only renames variants, not their fields.
        // The snake_case alias keeps older web builds working.
        #[serde(rename = "effectPassGroups", alias = "effect_pass_groups")]
        effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDescriptor {
    pub texture_id: String,
    pub transform: QuadTransformDescriptor,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    pub mask: Option<LayerMaskDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadTransformDescriptor {
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation_degrees: f32,
    pub flip_x: bool,
    pub flip_y: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMaskDescriptor {
    pub texture_id: String,
    pub feather: f32,
    pub inverted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPassDescriptor {
    pub shader: String,
    pub uniforms: HashMap<String, EffectUniformValueDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EffectUniformValueDescriptor {
    Number(f32),
    Vector(Vec<f32>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasTextureDescriptor {
    pub id: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene_effect_pass_count(json: &str) -> usize {
        match serde_json::from_str::<FrameItemDescriptor>(json).expect("valid frame item") {
            FrameItemDescriptor::SceneEffect { effect_pass_groups } => effect_pass_groups.len(),
            FrameItemDescriptor::Layer(_) => panic!("expected a scene effect"),
        }
    }

    #[test]
    fn scene_effect_accepts_camel_case_passes() {
        let json = r#"{"type":"sceneEffect","effectPassGroups":[[]]}"#;
        assert_eq!(scene_effect_pass_count(json), 1);
    }

    #[test]
    fn scene_effect_accepts_snake_case_passes() {
        let json = r#"{"type":"sceneEffect","effect_pass_groups":[[],[]]}"#;
        assert_eq!(scene_effect_pass_count(json), 2);
    }
}
