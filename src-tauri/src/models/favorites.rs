//! 收藏命令领域模型。

use serde::{Deserialize, Serialize};

// 收藏命令实体：记录语句、自定义备注及创建/更新时间戳
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteCommand {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub remark: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}
