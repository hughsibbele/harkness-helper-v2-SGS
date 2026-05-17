// Hand-written until we run `supabase gen types typescript` against a live
// project. Matches the migration schema in /supabase/migrations exactly.
//
// When the project goes live, replace this file with the generated output —
// the shapes should match.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      teachers: {
        Row: {
          id: string;
          auth_user_id: string;
          google_sub: string | null;
          email: string;
          display_name: string;
          gemini_daily_cap: number | null;
          last_canvas_sync_at: string | null;
          google_access_token: string | null;
          google_refresh_token: string | null;
          google_token_expires_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          auth_user_id: string;
          google_sub?: string | null;
          email: string;
          display_name: string;
          gemini_daily_cap?: number | null;
          last_canvas_sync_at?: string | null;
          google_access_token?: string | null;
          google_refresh_token?: string | null;
          google_token_expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          auth_user_id?: string;
          google_sub?: string | null;
          email?: string;
          display_name?: string;
          gemini_daily_cap?: number | null;
          last_canvas_sync_at?: string | null;
          google_access_token?: string | null;
          google_refresh_token?: string | null;
          google_token_expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      admins: {
        Row: {
          email: string;
          granted_by_email: string | null;
          granted_at: string;
          active: boolean;
        };
        Insert: {
          email: string;
          granted_by_email?: string | null;
          granted_at?: string;
          active?: boolean;
        };
        Update: {
          email?: string;
          granted_by_email?: string | null;
          granted_at?: string;
          active?: boolean;
        };
        Relationships: [];
      };
      prompts: {
        Row: {
          id: string;
          teacher_id: string | null;
          scope: "system" | "teacher";
          purpose: "transcription";
          label: string;
          body: string;
          is_default: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          teacher_id?: string | null;
          scope: "system" | "teacher";
          purpose: "transcription";
          label: string;
          body: string;
          is_default?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          teacher_id?: string | null;
          scope?: "system" | "teacher";
          purpose?: "transcription";
          label?: string;
          body?: string;
          is_default?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "prompts_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "teachers";
            referencedColumns: ["id"];
          },
        ];
      };
      students: {
        Row: {
          id: string;
          teacher_id: string;
          canvas_user_id: string;
          canvas_course_id: string;
          email: string;
          display_name: string;
          anon_token: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          teacher_id: string;
          canvas_user_id: string;
          canvas_course_id: string;
          email: string;
          display_name: string;
          anon_token: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          teacher_id?: string;
          canvas_user_id?: string;
          canvas_course_id?: string;
          email?: string;
          display_name?: string;
          anon_token?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "students_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "teachers";
            referencedColumns: ["id"];
          },
        ];
      };
      discussions: {
        Row: {
          id: string;
          teacher_id: string;
          canvas_assignment_id: string;
          canvas_course_id: string;
          canvas_section_id: string | null;
          recorded_at: string;
          audio_url: string;
          transcript: string | null;
          transcription_prompt_id: string | null;
          state: "uploaded" | "transcribing" | "transcribed" | "posted_to_super_grader" | "failed";
          super_grader_post_status: "pending" | "posted" | "error";
          super_grader_response: Json | null;
          error_message: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          teacher_id: string;
          canvas_assignment_id: string;
          canvas_course_id: string;
          canvas_section_id?: string | null;
          recorded_at: string;
          audio_url: string;
          transcript?: string | null;
          transcription_prompt_id?: string | null;
          state?: "uploaded" | "transcribing" | "transcribed" | "posted_to_super_grader" | "failed";
          super_grader_post_status?: "pending" | "posted" | "error";
          super_grader_response?: Json | null;
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          teacher_id?: string;
          canvas_assignment_id?: string;
          canvas_course_id?: string;
          canvas_section_id?: string | null;
          recorded_at?: string;
          audio_url?: string;
          transcript?: string | null;
          transcription_prompt_id?: string | null;
          state?: "uploaded" | "transcribing" | "transcribed" | "posted_to_super_grader" | "failed";
          super_grader_post_status?: "pending" | "posted" | "error";
          super_grader_response?: Json | null;
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "discussions_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "teachers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussions_transcription_prompt_id_fkey";
            columns: ["transcription_prompt_id"];
            isOneToOne: false;
            referencedRelation: "prompts";
            referencedColumns: ["id"];
          },
        ];
      };
      participations: {
        Row: {
          id: string;
          discussion_id: string;
          student_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          discussion_id: string;
          student_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          discussion_id?: string;
          student_id?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      canvas_course_cache: {
        Row: {
          teacher_id: string;
          canvas_course_id: string;
          name: string;
          course_code: string | null;
          workflow_state: string;
          start_at: string | null;
          end_at: string | null;
          term_name: string | null;
          term_start_at: string | null;
          term_end_at: string | null;
          last_synced_at: string;
        };
        Insert: {
          teacher_id: string;
          canvas_course_id: string;
          name: string;
          course_code?: string | null;
          workflow_state: string;
          start_at?: string | null;
          end_at?: string | null;
          term_name?: string | null;
          term_start_at?: string | null;
          term_end_at?: string | null;
          last_synced_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["canvas_course_cache"]["Insert"]>;
        Relationships: [];
      };
      canvas_assignment_cache: {
        Row: {
          teacher_id: string;
          canvas_course_id: string;
          canvas_assignment_id: string;
          name: string;
          description: string | null;
          due_at: string | null;
          points_possible: number | null;
          workflow_state: string;
          published: boolean | null;
          last_synced_at: string;
        };
        Insert: {
          teacher_id: string;
          canvas_course_id: string;
          canvas_assignment_id: string;
          name: string;
          description?: string | null;
          due_at?: string | null;
          points_possible?: number | null;
          workflow_state: string;
          published?: boolean | null;
          last_synced_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["canvas_assignment_cache"]["Insert"]>;
        Relationships: [];
      };
      course_rosters: {
        Row: {
          teacher_id: string;
          canvas_course_id: string;
          students: Json;
          sections: Json;
          last_synced_at: string;
        };
        Insert: {
          teacher_id: string;
          canvas_course_id: string;
          students?: Json;
          sections?: Json;
          last_synced_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["course_rosters"]["Insert"]>;
        Relationships: [];
      };
      gemini_usage_daily: {
        Row: {
          teacher_id: string;
          date: string;
          calls: number;
          denials: number;
          updated_at: string;
        };
        Insert: {
          teacher_id: string;
          date: string;
          calls?: number;
          denials?: number;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["gemini_usage_daily"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_teacher_owner: {
        Args: { t_id: string };
        Returns: boolean;
      };
      is_admin: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      check_and_increment_gemini_call: {
        Args: { p_teacher_id: string; p_default_cap: number };
        Returns: {
          allowed: boolean;
          calls_today: number;
          denials_today: number;
          daily_cap: number;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
