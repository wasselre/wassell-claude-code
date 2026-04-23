import React from 'react';
import type { Reel, Post } from '@/types';

const PAGE_STYLE: React.CSSProperties = {
  width: '794px',
  minHeight: '1123px',
  padding: '48px',
  background: '#F5EDE0',
  fontFamily: "'Amiri', serif",
  color: '#4A4E54',
  direction: 'rtl',
  boxSizing: 'border-box',
};

const CARD_STYLE: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid rgba(212, 184, 150, 0.5)',
  borderRadius: '12px',
  padding: '20px',
  marginBottom: '16px',
  breakInside: 'avoid',
};

const HEADER_STYLE: React.CSSProperties = {
  borderBottom: '2px solid #B8734F',
  paddingBottom: '16px',
  marginBottom: '24px',
};

const META_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: '16px',
  flexWrap: 'wrap',
  fontSize: '13px',
  color: '#4A4E54',
  marginBottom: '12px',
};

const META_LABEL: React.CSSProperties = {
  color: 'rgba(74, 78, 84, 0.6)',
  marginInlineEnd: '4px',
};

export interface ReelsPdfTemplateProps {
  projectName: string;
  reels: Reel[];
}

export const ReelsPdfTemplate = React.forwardRef<HTMLDivElement, ReelsPdfTemplateProps>(
  ({ projectName, reels }, ref) => {
    return (
      <div ref={ref} style={PAGE_STYLE}>
        <div style={HEADER_STYLE}>
          <div style={{ fontSize: '12px', color: '#B8734F', marginBottom: '4px' }}>
            وصل العقارية · تسويق
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: '#4A2C2A' }}>
            ريلز — {projectName}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(74, 78, 84, 0.6)', marginTop: '4px' }}>
            {reels.length} ريل
          </div>
        </div>
        {reels.map((reel) => (
          <div key={reel.id} style={CARD_STYLE}>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#4A2C2A', marginBottom: '12px' }}>
              ريل #{reel.reel_number}
              {reel.goal ? (
                <span style={{ fontSize: '13px', color: '#B8734F', marginInlineStart: '12px' }}>
                  — {reel.goal}
                </span>
              ) : null}
            </div>
            <div style={META_ROW_STYLE}>
              {reel.type && (
                <span>
                  <span style={META_LABEL}>النوع:</span>
                  {reel.type}
                </span>
              )}
              {reel.duration && (
                <span>
                  <span style={META_LABEL}>المدة:</span>
                  {reel.duration} ث
                </span>
              )}
              {reel.platform && (
                <span>
                  <span style={META_LABEL}>المنصة:</span>
                  {reel.platform}
                </span>
              )}
              {reel.voiceover && (
                <span>
                  <span style={META_LABEL}>التعليق الصوتي:</span>
                  {reel.voiceover}
                </span>
              )}
            </div>
            {Array.isArray(reel.scenes) && reel.scenes.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                {reel.scenes.map((scene, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      gap: '12px',
                      alignItems: 'flex-start',
                      padding: '12px 0',
                      borderTop: idx === 0 ? 'none' : '1px dashed rgba(212, 184, 150, 0.5)',
                    }}
                  >
                    <div
                      style={{
                        minWidth: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        background: '#B8734F',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '12px',
                        fontWeight: 700,
                      }}
                    >
                      {scene.number}
                    </div>
                    <div style={{ flex: 1 }}>
                      {scene.description && (
                        <div
                          style={{
                            fontSize: '12px',
                            color: 'rgba(74, 78, 84, 0.6)',
                            marginBottom: '4px',
                          }}
                        >
                          {scene.description}
                        </div>
                      )}
                      <div style={{ fontSize: '14px', lineHeight: 1.7 }}>{scene.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  },
);
ReelsPdfTemplate.displayName = 'ReelsPdfTemplate';

export interface PostsPdfTemplateProps {
  projectName: string;
  posts: Post[];
}

export const PostsPdfTemplate = React.forwardRef<HTMLDivElement, PostsPdfTemplateProps>(
  ({ projectName, posts }, ref) => {
    return (
      <div ref={ref} style={PAGE_STYLE}>
        <div style={HEADER_STYLE}>
          <div style={{ fontSize: '12px', color: '#B8734F', marginBottom: '4px' }}>
            وصل العقارية · تسويق
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: '#4A2C2A' }}>
            منشورات — {projectName}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(74, 78, 84, 0.6)', marginTop: '4px' }}>
            {posts.length} منشور
          </div>
        </div>
        {posts.map((post) => (
          <div key={post.id} style={CARD_STYLE}>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#4A2C2A', marginBottom: '12px' }}>
              منشور #{post.post_number}
              {post.title ? (
                <span style={{ fontSize: '15px', fontWeight: 400, marginInlineStart: '12px' }}>
                  — {post.title}
                </span>
              ) : null}
            </div>
            <div style={META_ROW_STYLE}>
              {post.type && (
                <span>
                  <span style={META_LABEL}>النوع:</span>
                  {post.type}
                </span>
              )}
              {post.components && (
                <span>
                  <span style={META_LABEL}>المكوّنات:</span>
                  {post.components}
                </span>
              )}
              {post.visual && (
                <span>
                  <span style={META_LABEL}>البصري:</span>
                  {post.visual}
                </span>
              )}
              {post.usage && (
                <span>
                  <span style={META_LABEL}>الاستخدام:</span>
                  {post.usage}
                </span>
              )}
            </div>
            {(post.design_text_1 || post.design_text_2 || post.design_text_3) && (
              <div style={{ marginTop: '8px', fontSize: '14px', lineHeight: 1.8 }}>
                {post.design_text_1 && (
                  <DesignTextRow label="النص 1" text={post.design_text_1} />
                )}
                {post.design_text_2 && (
                  <DesignTextRow label="النص 2" text={post.design_text_2} />
                )}
                {post.design_text_3 && (
                  <DesignTextRow label="النص 3" text={post.design_text_3} />
                )}
              </div>
            )}
            {post.caption && (
              <div
                style={{
                  marginTop: '12px',
                  paddingTop: '12px',
                  borderTop: '1px dashed rgba(212, 184, 150, 0.5)',
                  fontSize: '13px',
                  lineHeight: 1.8,
                  color: 'rgba(74, 78, 84, 0.85)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                <div style={{ ...META_LABEL, marginBottom: '6px' }}>التعليق:</div>
                {post.caption}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  },
);
PostsPdfTemplate.displayName = 'PostsPdfTemplate';

function DesignTextRow({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ marginBottom: '6px' }}>
      <span style={META_LABEL}>{label}:</span>
      <span>{text}</span>
    </div>
  );
}
